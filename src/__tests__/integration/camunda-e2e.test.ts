import * as path from 'path';
import { parseCamundaWorkflow } from '../../parsers/camunda';
import { convertCamundaToASL } from '../../mappers/camunda-to-asl';
import { logger, LogLevel } from '../../utils/logger';

// Suppress logger output during tests
beforeAll(() => logger.setLevel(LogLevel.SILENT));

/**
 * Integration tests: end-to-end conversion of the real media-processing.bpmn file.
 * These tests verify the full pipeline from BPMN XML parsing to ASL generation.
 */
describe('Camunda end-to-end integration', () => {
  const BPMN_FILE = path.resolve(__dirname, '../../../../camunda-reference/media-processing.bpmn');

  let result: ReturnType<typeof convertCamundaToASL>;

  beforeAll(() => {
    const process = parseCamundaWorkflow(BPMN_FILE);
    result = convertCamundaToASL(process);
  });

  it('should successfully parse and convert the real media-processing.bpmn file', () => {
    expect(result).toBeDefined();
    expect(result.stateMachine).toBeDefined();
    expect(result.stateMachine.States).toBeDefined();
  });

  it('should generate valid JSON that can be parsed back', () => {
    const jsonString = JSON.stringify(result.stateMachine);
    const parsed = JSON.parse(jsonString);

    expect(parsed.StartAt).toBeDefined();
    expect(parsed.States).toBeDefined();
    expect(typeof parsed.States).toBe('object');
  });

  it('should have correct StartAt pointing to first task after start event', () => {
    // The first task after the start event is "Extract Media Info" → "ExtractMediaInfo"
    expect(result.stateMachine.StartAt).toBe('ExtractMediaInfo');
  });

  it('should have WorkflowComplete and HandleError terminal states', () => {
    expect(result.stateMachine.States['WorkflowComplete']).toBeDefined();
    expect((result.stateMachine.States['WorkflowComplete'] as any).Type).toBe('Succeed');

    expect(result.stateMachine.States['HandleError']).toBeDefined();
    expect((result.stateMachine.States['HandleError'] as any).Type).toBe('Fail');
  });

  it('should generate Task states with Retry and Catch blocks', () => {
    const taskStates = Object.entries(result.stateMachine.States)
      .filter(([_, state]) => (state as any).Type === 'Task');

    expect(taskStates.length).toBeGreaterThan(0);

    for (const [name, state] of taskStates) {
      const taskState = state as any;
      // All Task states should have Catch blocks
      expect(taskState.Catch).toBeDefined();
      expect(taskState.Catch.length).toBeGreaterThan(0);

      // All Task states should have Retry blocks (either explicit or default)
      if (taskState.Retry) {
        expect(taskState.Retry.length).toBeGreaterThan(0);
        expect(taskState.Retry[0].ErrorEquals).toBeDefined();
      }
    }
  });

  it('should generate a Choice state from the exclusive gateway', () => {
    // The BPMN has an exclusive gateway "Video or Audio?" → "VideoOrAudio"
    const choiceStates = Object.entries(result.stateMachine.States)
      .filter(([_, state]) => (state as any).Type === 'Choice');

    expect(choiceStates.length).toBeGreaterThan(0);

    const [_, choiceState] = choiceStates[0];
    const choice = choiceState as any;
    expect(choice.Choices).toBeDefined();
    expect(choice.Choices.length).toBeGreaterThan(0);

    // Should have conditions derived from the BPMN gateway
    const hasMediaTypeCondition = choice.Choices.some(
      (c: any) => c.Variable && c.Variable.includes('mediaType')
    );
    expect(hasMediaTypeCondition).toBe(true);
  });

  it('should include conversion metadata with task counts', () => {
    expect(result.metadata).toBeDefined();
    expect(result.metadata.sourceTaskCount).toBeGreaterThan(0);
    expect(result.metadata.generatedStateCount).toBeGreaterThan(0);
    // Generated states should include task states + terminal states
    expect(result.metadata.generatedStateCount).toBeGreaterThanOrEqual(
      result.metadata.sourceTaskCount + 2 // +2 for WorkflowComplete and HandleError
    );
  });
});
