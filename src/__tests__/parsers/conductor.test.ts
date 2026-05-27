import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseConductorWorkflow } from '../../parsers/conductor';
import { WorkflowMigratorError, ParseError, ValidationError, ErrorCode } from '../../utils/errors';
import { logger, LogLevel } from '../../utils/logger';

// Suppress logger output during tests
beforeAll(() => logger.setLevel(LogLevel.SILENT));

describe('parseConductorWorkflow', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfm-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeWorkflow(filename: string, content: any): string {
    const filePath = path.join(tmpDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(content), 'utf-8');
    return filePath;
  }

  // --- Happy Path ---

  describe('happy path', () => {
    it('should parse a valid minimal workflow', () => {
      const filePath = writeWorkflow('valid.json', {
        name: 'test_workflow',
        version: 1,
        tasks: [
          { name: 'task1', taskReferenceName: 'ref1', type: 'HTTP' },
        ],
      });

      const result = parseConductorWorkflow(filePath);

      expect(result.name).toBe('test_workflow');
      expect(result.version).toBe(1);
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].type).toBe('HTTP');
    });

    it('should parse a workflow with multiple tasks', () => {
      const filePath = writeWorkflow('multi.json', {
        name: 'multi_task',
        version: 2,
        tasks: [
          { name: 'task1', taskReferenceName: 'ref1', type: 'HTTP' },
          { name: 'task2', taskReferenceName: 'ref2', type: 'SIMPLE' },
          { name: 'task3', taskReferenceName: 'ref3', type: 'WAIT' },
        ],
      });

      const result = parseConductorWorkflow(filePath);

      expect(result.tasks).toHaveLength(3);
    });

    it('should parse a workflow with DECISION tasks and nested branches', () => {
      const filePath = writeWorkflow('decision.json', {
        name: 'decision_workflow',
        version: 1,
        tasks: [
          {
            name: 'decide',
            taskReferenceName: 'decision_ref',
            type: 'DECISION',
            caseValueParam: 'status',
            decisionCases: {
              active: [
                { name: 'active_task', taskReferenceName: 'active_ref', type: 'HTTP' },
              ],
            },
          },
        ],
      });

      const result = parseConductorWorkflow(filePath);

      expect(result.tasks[0].type).toBe('DECISION');
      expect(result.tasks[0].decisionCases).toBeDefined();
    });

    it('should preserve optional fields', () => {
      const filePath = writeWorkflow('full.json', {
        name: 'full_workflow',
        version: 3,
        description: 'A complete workflow',
        timeoutSeconds: 600,
        restartable: true,
        ownerEmail: 'test@example.com',
        tasks: [
          { name: 'task1', taskReferenceName: 'ref1', type: 'HTTP', timeoutSeconds: 30, retryCount: 2 },
        ],
      });

      const result = parseConductorWorkflow(filePath);

      expect(result.description).toBe('A complete workflow');
      expect(result.timeoutSeconds).toBe(600);
      expect(result.restartable).toBe(true);
      expect(result.tasks[0].timeoutSeconds).toBe(30);
      expect(result.tasks[0].retryCount).toBe(2);
    });
  });

  // --- Negative Tests: File System Errors ---

  describe('file system errors', () => {
    it('should throw FILE_NOT_FOUND for non-existent file', () => {
      expect(() => parseConductorWorkflow('/nonexistent/path.json')).toThrow(WorkflowMigratorError);

      try {
        parseConductorWorkflow('/nonexistent/path.json');
      } catch (e: any) {
        expect(e.code).toBe(ErrorCode.FILE_NOT_FOUND);
      }
    });

    it('should throw FILE_TOO_LARGE for oversized files', () => {
      const filePath = path.join(tmpDir, 'large.json');
      // Create a file just over 10MB
      const largeContent = 'x'.repeat(10 * 1024 * 1024 + 1);
      fs.writeFileSync(filePath, largeContent);

      expect(() => parseConductorWorkflow(filePath)).toThrow(WorkflowMigratorError);

      try {
        parseConductorWorkflow(filePath);
      } catch (e: any) {
        expect(e.code).toBe(ErrorCode.FILE_TOO_LARGE);
      }
    });
  });

  // --- Negative Tests: Parse Errors ---

  describe('parse errors', () => {
    it('should throw ParseError for invalid JSON', () => {
      const filePath = path.join(tmpDir, 'invalid.json');
      fs.writeFileSync(filePath, '{ not valid json }');

      expect(() => parseConductorWorkflow(filePath)).toThrow(ParseError);
    });

    it('should throw ParseError for empty file', () => {
      const filePath = path.join(tmpDir, 'empty.json');
      fs.writeFileSync(filePath, '');

      expect(() => parseConductorWorkflow(filePath)).toThrow(ParseError);
    });
  });

  // --- Negative Tests: Validation Errors ---

  describe('validation errors', () => {
    it('should throw ValidationError for missing name', () => {
      const filePath = writeWorkflow('no-name.json', {
        version: 1,
        tasks: [{ name: 'task1', taskReferenceName: 'ref1', type: 'HTTP' }],
      });

      expect(() => parseConductorWorkflow(filePath)).toThrow(ValidationError);
    });

    it('should throw ValidationError for missing tasks array', () => {
      const filePath = writeWorkflow('no-tasks.json', {
        name: 'test',
        version: 1,
      });

      expect(() => parseConductorWorkflow(filePath)).toThrow(ValidationError);
    });

    it('should throw ValidationError for empty tasks array', () => {
      const filePath = writeWorkflow('empty-tasks.json', {
        name: 'test',
        version: 1,
        tasks: [],
      });

      expect(() => parseConductorWorkflow(filePath)).toThrow(ValidationError);
    });

    it('should throw ValidationError for task missing name', () => {
      const filePath = writeWorkflow('task-no-name.json', {
        name: 'test',
        version: 1,
        tasks: [{ taskReferenceName: 'ref1', type: 'HTTP' }],
      });

      expect(() => parseConductorWorkflow(filePath)).toThrow(ValidationError);
    });

    it('should throw ValidationError for task missing taskReferenceName', () => {
      const filePath = writeWorkflow('task-no-ref.json', {
        name: 'test',
        version: 1,
        tasks: [{ name: 'task1', type: 'HTTP' }],
      });

      expect(() => parseConductorWorkflow(filePath)).toThrow(ValidationError);
    });

    it('should throw ValidationError for task missing type', () => {
      const filePath = writeWorkflow('task-no-type.json', {
        name: 'test',
        version: 1,
        tasks: [{ name: 'task1', taskReferenceName: 'ref1' }],
      });

      expect(() => parseConductorWorkflow(filePath)).toThrow(ValidationError);
    });

    it('should throw ValidationError for duplicate taskReferenceName', () => {
      const filePath = writeWorkflow('dup-ref.json', {
        name: 'test',
        version: 1,
        tasks: [
          { name: 'task1', taskReferenceName: 'same_ref', type: 'HTTP' },
          { name: 'task2', taskReferenceName: 'same_ref', type: 'HTTP' },
        ],
      });

      expect(() => parseConductorWorkflow(filePath)).toThrow(ValidationError);
      try {
        parseConductorWorkflow(filePath);
      } catch (e: any) {
        expect(e.message).toContain('duplicate taskReferenceName');
      }
    });

    it('should throw ValidationError when tasks exceed maximum', () => {
      const tasks = Array.from({ length: 501 }, (_, i) => ({
        name: `task_${i}`,
        taskReferenceName: `ref_${i}`,
        type: 'HTTP',
      }));

      const filePath = writeWorkflow('too-many.json', {
        name: 'test',
        version: 1,
        tasks,
      });

      expect(() => parseConductorWorkflow(filePath)).toThrow(ValidationError);
      try {
        parseConductorWorkflow(filePath);
      } catch (e: any) {
        expect(e.message).toContain('exceeds maximum');
      }
    });

    it('should validate nested tasks in DECISION branches', () => {
      const filePath = writeWorkflow('bad-nested.json', {
        name: 'test',
        version: 1,
        tasks: [
          {
            name: 'decide',
            taskReferenceName: 'decision_ref',
            type: 'DECISION',
            decisionCases: {
              yes: [{ name: 'nested', type: 'HTTP' }], // missing taskReferenceName
            },
          },
        ],
      });

      expect(() => parseConductorWorkflow(filePath)).toThrow(ValidationError);
    });
  });

  // --- Edge Cases ---

  describe('edge cases', () => {
    it('should handle workflow with non-object value (array)', () => {
      const filePath = path.join(tmpDir, 'array.json');
      fs.writeFileSync(filePath, JSON.stringify([1, 2, 3]));

      expect(() => parseConductorWorkflow(filePath)).toThrow(ValidationError);
    });

    it('should handle workflow with null value', () => {
      const filePath = path.join(tmpDir, 'null.json');
      fs.writeFileSync(filePath, 'null');

      expect(() => parseConductorWorkflow(filePath)).toThrow(ValidationError);
    });

    it('should handle exactly 500 tasks (at the limit)', () => {
      const tasks = Array.from({ length: 500 }, (_, i) => ({
        name: `task_${i}`,
        taskReferenceName: `ref_${i}`,
        type: 'HTTP',
      }));

      const filePath = writeWorkflow('at-limit.json', {
        name: 'test',
        version: 1,
        tasks,
      });

      const result = parseConductorWorkflow(filePath);
      expect(result.tasks).toHaveLength(500);
    });
  });
});
