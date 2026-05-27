import { convertConductorToASL, ConversionResult } from '../../mappers/conductor-to-asl';
import { ConductorWorkflow } from '../../types/conductor';
import { logger, LogLevel } from '../../utils/logger';

beforeAll(() => logger.setLevel(LogLevel.SILENT));

function makeWorkflow(overrides: Partial<ConductorWorkflow> = {}): ConductorWorkflow {
  return {
    name: 'test_workflow',
    version: 1,
    tasks: [
      { name: 'task1', taskReferenceName: 'my_task', type: 'HTTP', inputParameters: {} },
    ],
    ...overrides,
  };
}

describe('convertConductorToASL', () => {
  // --- Happy Path ---

  describe('happy path', () => {
    it('should convert a single HTTP task to a Task state', () => {
      const workflow = makeWorkflow();
      const result = convertConductorToASL(workflow);

      expect(result.stateMachine.StartAt).toBe('MyTask');
      expect(result.stateMachine.States['MyTask']).toBeDefined();
      expect(result.stateMachine.States['MyTask'].Type).toBe('Task');
      expect(result.stateMachine.States['WorkflowComplete']).toBeDefined();
      expect(result.stateMachine.States['HandleError']).toBeDefined();
    });

    it('should chain multiple tasks sequentially', () => {
      const workflow = makeWorkflow({
        tasks: [
          { name: 'first', taskReferenceName: 'first_task', type: 'HTTP' },
          { name: 'second', taskReferenceName: 'second_task', type: 'HTTP' },
          { name: 'third', taskReferenceName: 'third_task', type: 'HTTP' },
        ],
      });

      const result = convertConductorToASL(workflow);

      expect(result.stateMachine.StartAt).toBe('FirstTask');
      expect((result.stateMachine.States['FirstTask'] as any).Next).toBe('SecondTask');
      expect((result.stateMachine.States['SecondTask'] as any).Next).toBe('ThirdTask');
      expect((result.stateMachine.States['ThirdTask'] as any).Next).toBe('WorkflowComplete');
    });

    it('should include Comment with workflow name and description', () => {
      const workflow = makeWorkflow({ description: 'My test workflow' });
      const result = convertConductorToASL(workflow);

      expect(result.stateMachine.Comment).toContain('test_workflow');
      expect(result.stateMachine.Comment).toContain('My test workflow');
    });

    it('should set TimeoutSeconds from workflow timeout', () => {
      const workflow = makeWorkflow({ timeoutSeconds: 300 });
      const result = convertConductorToASL(workflow);

      expect(result.stateMachine.TimeoutSeconds).toBe(300);
    });

    it('should not set TimeoutSeconds when workflow has no timeout', () => {
      const workflow = makeWorkflow();
      const result = convertConductorToASL(workflow);

      expect(result.stateMachine.TimeoutSeconds).toBeUndefined();
    });

    it('should generate Retry block when retryCount is set', () => {
      const workflow = makeWorkflow({
        tasks: [
          { name: 'task1', taskReferenceName: 'retry_task', type: 'HTTP', retryCount: 3 },
        ],
      });

      const result = convertConductorToASL(workflow);
      const state = result.stateMachine.States['RetryTask'] as any;

      expect(state.Retry).toBeDefined();
      expect(state.Retry[0].MaxAttempts).toBe(3);
      expect(state.Retry[0].BackoffRate).toBe(2.0);
    });

    it('should not generate Retry block when retryCount is 0', () => {
      const workflow = makeWorkflow({
        tasks: [
          { name: 'task1', taskReferenceName: 'no_retry', type: 'HTTP', retryCount: 0 },
        ],
      });

      const result = convertConductorToASL(workflow);
      const state = result.stateMachine.States['NoRetry'] as any;

      expect(state.Retry).toBeUndefined();
    });

    it('should always generate Catch block pointing to HandleError', () => {
      const workflow = makeWorkflow();
      const result = convertConductorToASL(workflow);
      const state = result.stateMachine.States['MyTask'] as any;

      expect(state.Catch).toBeDefined();
      expect(state.Catch[0].Next).toBe('HandleError');
      expect(state.Catch[0].ErrorEquals).toContain('States.ALL');
    });
  });

  // --- DECISION/SWITCH Conversion ---

  describe('DECISION/SWITCH tasks', () => {
    it('should convert DECISION to Choice state', () => {
      const workflow = makeWorkflow({
        tasks: [
          {
            name: 'decide',
            taskReferenceName: 'my_decision',
            type: 'DECISION',
            caseValueParam: 'status',
            decisionCases: {
              active: [
                { name: 'active_handler', taskReferenceName: 'handle_active', type: 'HTTP' },
              ],
            },
          },
        ],
      });

      const result = convertConductorToASL(workflow);

      expect(result.stateMachine.States['MyDecision']).toBeDefined();
      expect(result.stateMachine.States['MyDecision'].Type).toBe('Choice');
      expect((result.stateMachine.States['MyDecision'] as any).Default).toBe('WorkflowComplete');
    });

    it('should not have Next property on Choice state', () => {
      const workflow = makeWorkflow({
        tasks: [
          {
            name: 'decide',
            taskReferenceName: 'my_decision',
            type: 'DECISION',
            caseValueParam: 'status',
            decisionCases: {
              yes: [{ name: 'yes_task', taskReferenceName: 'yes_ref', type: 'HTTP' }],
            },
          },
        ],
      });

      const result = convertConductorToASL(workflow);
      const choiceState = result.stateMachine.States['MyDecision'] as any;

      // Choice states must NOT have Next — they use Default for fallback
      expect(choiceState.Next).toBeUndefined();
    });

    it('should generate branch states for each decision case', () => {
      const workflow = makeWorkflow({
        tasks: [
          {
            name: 'decide',
            taskReferenceName: 'route',
            type: 'DECISION',
            caseValueParam: 'type',
            decisionCases: {
              video: [{ name: 'video_task', taskReferenceName: 'process_video', type: 'HTTP' }],
              audio: [{ name: 'audio_task', taskReferenceName: 'process_audio', type: 'HTTP' }],
            },
          },
        ],
      });

      const result = convertConductorToASL(workflow);

      expect(result.stateMachine.States['Route_video']).toBeDefined();
      expect(result.stateMachine.States['Route_audio']).toBeDefined();
    });

    it('should warn when DECISION has no cases', () => {
      const workflow = makeWorkflow({
        tasks: [
          { name: 'decide', taskReferenceName: 'empty_decision', type: 'DECISION' },
        ],
      });

      const result = convertConductorToASL(workflow);

      expect(result.warnings.some(w => w.includes('no decisionCases'))).toBe(true);
    });
  });

  // --- FORK_JOIN Conversion ---

  describe('FORK_JOIN tasks', () => {
    it('should convert FORK_JOIN to Parallel state', () => {
      const workflow = makeWorkflow({
        tasks: [
          {
            name: 'fork',
            taskReferenceName: 'parallel_work',
            type: 'FORK_JOIN',
            forkTasks: [
              [{ name: 'branch1', taskReferenceName: 'b1', type: 'HTTP' }],
              [{ name: 'branch2', taskReferenceName: 'b2', type: 'HTTP' }],
            ],
          },
        ],
      });

      const result = convertConductorToASL(workflow);
      const state = result.stateMachine.States['ParallelWork'] as any;

      expect(state.Type).toBe('Parallel');
      expect(state.Branches).toHaveLength(2);
    });

    it('should generate warning for FORK_JOIN conversion', () => {
      const workflow = makeWorkflow({
        tasks: [
          {
            name: 'fork',
            taskReferenceName: 'my_fork',
            type: 'FORK_JOIN',
            forkTasks: [[{ name: 'b1', taskReferenceName: 'branch1', type: 'HTTP' }]],
          },
        ],
      });

      const result = convertConductorToASL(workflow);

      expect(result.warnings.some(w => w.includes('Verify branch independence'))).toBe(true);
    });
  });

  // --- WAIT Conversion ---

  describe('WAIT tasks', () => {
    it('should convert WAIT to Wait state with timeout', () => {
      const workflow = makeWorkflow({
        tasks: [
          { name: 'pause', taskReferenceName: 'wait_step', type: 'WAIT', timeoutSeconds: 30 },
        ],
      });

      const result = convertConductorToASL(workflow);
      const state = result.stateMachine.States['WaitStep'] as any;

      expect(state.Type).toBe('Wait');
      expect(state.Seconds).toBe(30);
    });

    it('should default to 60 seconds when no timeout specified', () => {
      const workflow = makeWorkflow({
        tasks: [
          { name: 'pause', taskReferenceName: 'default_wait', type: 'WAIT' },
        ],
      });

      const result = convertConductorToASL(workflow);
      const state = result.stateMachine.States['DefaultWait'] as any;

      expect(state.Seconds).toBe(60);
    });
  });

  // --- SUB_WORKFLOW Conversion ---

  describe('SUB_WORKFLOW tasks', () => {
    it('should convert SUB_WORKFLOW to StartExecution task', () => {
      const workflow = makeWorkflow({
        tasks: [
          {
            name: 'sub',
            taskReferenceName: 'child_workflow',
            type: 'SUB_WORKFLOW',
            subWorkflowParam: { name: 'child_process', version: 1 },
          },
        ],
      });

      const result = convertConductorToASL(workflow);
      const state = result.stateMachine.States['ChildWorkflow'] as any;

      expect(state.Type).toBe('Task');
      expect(state.Resource).toContain('startExecution');
      expect(state.Parameters.StateMachineArn).toContain('child_process');
    });

    it('should warn about sub-workflow needing separate migration', () => {
      const workflow = makeWorkflow({
        tasks: [
          {
            name: 'sub',
            taskReferenceName: 'nested',
            type: 'SUB_WORKFLOW',
            subWorkflowParam: { name: 'other_workflow' },
          },
        ],
      });

      const result = convertConductorToASL(workflow);

      expect(result.warnings.some(w => w.includes('migrate that workflow separately'))).toBe(true);
    });
  });

  // --- TERMINATE Conversion ---

  describe('TERMINATE tasks', () => {
    it('should convert TERMINATE to Fail state', () => {
      const workflow = makeWorkflow({
        tasks: [
          { name: 'stop', taskReferenceName: 'abort_workflow', type: 'TERMINATE' },
        ],
      });

      const result = convertConductorToASL(workflow);
      const state = result.stateMachine.States['AbortWorkflow'] as any;

      expect(state.Type).toBe('Fail');
      expect(state.Error).toBe('WorkflowTerminated');
    });
  });

  // --- Unsupported Types ---

  describe('unsupported task types', () => {
    it('should convert unsupported types to Pass state with TODO comment', () => {
      const workflow = makeWorkflow({
        tasks: [
          { name: 'event_task', taskReferenceName: 'my_event', type: 'EVENT' },
        ],
      });

      const result = convertConductorToASL(workflow);
      const state = result.stateMachine.States['MyEvent'] as any;

      expect(state.Type).toBe('Pass');
      expect(state.Comment).toContain('TODO');
    });

    it('should track unsupported constructs in metadata', () => {
      const workflow = makeWorkflow({
        tasks: [
          { name: 'event_task', taskReferenceName: 'evt', type: 'EVENT' },
          { name: 'set_var', taskReferenceName: 'sv', type: 'SET_VARIABLE' },
        ],
      });

      const result = convertConductorToASL(workflow);

      expect(result.metadata.unsupportedConstructs).toContain('EVENT');
      expect(result.metadata.unsupportedConstructs).toContain('SET_VARIABLE');
    });
  });

  // --- Expression Mapping ---

  describe('expression mapping', () => {
    it('should convert workflow.input expressions to JsonPath', () => {
      const workflow = makeWorkflow({
        tasks: [
          {
            name: 'task1',
            taskReferenceName: 'expr_task',
            type: 'HTTP',
            inputParameters: {
              http_request: {
                body: {
                  fileId: '${workflow.input.fileId}',
                  bucket: '${workflow.input.outputBucket}',
                },
              },
            },
          },
        ],
      });

      const result = convertConductorToASL(workflow);
      const state = result.stateMachine.States['ExprTask'] as any;

      expect(state.Parameters['fileId.$']).toBe('$.fileId');
      expect(state.Parameters['bucket.$']).toBe('$.outputBucket');
    });

    it('should convert task output expressions to JsonPath', () => {
      const workflow = makeWorkflow({
        tasks: [
          {
            name: 'task1',
            taskReferenceName: 'output_task',
            type: 'HTTP',
            inputParameters: {
              http_request: {
                body: {
                  data: '${prev_task.output.response.body.result}',
                },
              },
            },
          },
        ],
      });

      const result = convertConductorToASL(workflow);
      const state = result.stateMachine.States['OutputTask'] as any;

      expect(state.Parameters['data.$']).toBe('$.prev_task.result');
    });

    it('should preserve static values without JsonPath suffix', () => {
      const workflow = makeWorkflow({
        tasks: [
          {
            name: 'task1',
            taskReferenceName: 'static_task',
            type: 'HTTP',
            inputParameters: {
              http_request: {
                body: {
                  action: 'process',
                  count: 42,
                  enabled: true,
                },
              },
            },
          },
        ],
      });

      const result = convertConductorToASL(workflow);
      const state = result.stateMachine.States['StaticTask'] as any;

      expect(state.Parameters['action']).toBe('process');
      expect(state.Parameters['count']).toBe(42);
      expect(state.Parameters['enabled']).toBe(true);
    });
  });

  // --- Metadata ---

  describe('metadata', () => {
    it('should report correct source task count', () => {
      const workflow = makeWorkflow({
        tasks: [
          { name: 't1', taskReferenceName: 'r1', type: 'HTTP' },
          { name: 't2', taskReferenceName: 'r2', type: 'HTTP' },
        ],
      });

      const result = convertConductorToASL(workflow);

      expect(result.metadata.sourceTaskCount).toBe(2);
    });

    it('should report correct generated state count (includes WorkflowComplete + HandleError)', () => {
      const workflow = makeWorkflow({
        tasks: [
          { name: 't1', taskReferenceName: 'r1', type: 'HTTP' },
        ],
      });

      const result = convertConductorToASL(workflow);

      // 1 task state + WorkflowComplete + HandleError = 3
      expect(result.metadata.generatedStateCount).toBe(3);
    });
  });

  // --- State Name Generation ---

  describe('state name generation', () => {
    it('should convert snake_case to PascalCase', () => {
      const workflow = makeWorkflow({
        tasks: [
          { name: 'task', taskReferenceName: 'my_long_task_name', type: 'HTTP' },
        ],
      });

      const result = convertConductorToASL(workflow);

      expect(result.stateMachine.States['MyLongTaskName']).toBeDefined();
    });

    it('should handle single-word references', () => {
      const workflow = makeWorkflow({
        tasks: [
          { name: 'task', taskReferenceName: 'simple', type: 'HTTP' },
        ],
      });

      const result = convertConductorToASL(workflow);

      expect(result.stateMachine.States['Simple']).toBeDefined();
    });
  });
});
