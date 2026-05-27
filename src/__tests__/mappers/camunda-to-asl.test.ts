import { convertCamundaToASL } from '../../mappers/camunda-to-asl';
import { CamundaProcess, BPMNElement, SequenceFlow, ServiceTask, BoundaryEvent } from '../../types/camunda';
import { logger, LogLevel } from '../../utils/logger';

// Suppress logger output during tests
beforeAll(() => logger.setLevel(LogLevel.SILENT));

/** Helper to build a minimal CamundaProcess for testing */
function makeProcess(overrides: Partial<CamundaProcess> = {}): CamundaProcess {
  return {
    id: 'Process_Test',
    name: 'Test Process',
    isExecutable: true,
    elements: [
      { type: 'startEvent', id: 'Start_1', outgoing: ['Flow_1'] },
      { type: 'serviceTask', id: 'Task_1', name: 'Do Work', topic: 'do-work', taskType: 'external', incoming: ['Flow_1'], outgoing: ['Flow_2'] } as ServiceTask,
      { type: 'endEvent', id: 'End_1', incoming: ['Flow_2'] },
    ],
    sequenceFlows: [
      { id: 'Flow_1', sourceRef: 'Start_1', targetRef: 'Task_1' },
      { id: 'Flow_2', sourceRef: 'Task_1', targetRef: 'End_1' },
    ],
    ...overrides,
  };
}

describe('convertCamundaToASL', () => {
  // --- Happy Path ---

  describe('happy path', () => {
    it('should convert a simple linear workflow (start → task → end) to ASL', () => {
      const process = makeProcess();
      const result = convertCamundaToASL(process);

      expect(result.stateMachine.StartAt).toBeDefined();
      expect(result.stateMachine.States).toBeDefined();
      expect(Object.keys(result.stateMachine.States).length).toBeGreaterThan(0);
      expect(result.stateMachine.States['WorkflowComplete']).toBeDefined();
      expect(result.stateMachine.States['HandleError']).toBeDefined();
    });

    it('should set StartAt to the first task after start event', () => {
      const process = makeProcess();
      const result = convertCamundaToASL(process);

      // StartAt should point to the state generated from Task_1 (named "Do Work" → "DoWork")
      expect(result.stateMachine.StartAt).toBe('DoWork');
    });

    it('should include Comment with process name and id', () => {
      const process = makeProcess();
      const result = convertCamundaToASL(process);

      expect(result.stateMachine.Comment).toContain('Test Process');
      expect(result.stateMachine.Comment).toContain('Process_Test');
    });
  });

  // --- Service Task Conversion ---

  describe('service task conversion', () => {
    it('should convert service task to Lambda Task state with function name from topic', () => {
      const process = makeProcess();
      const result = convertCamundaToASL(process);

      const state = result.stateMachine.States['DoWork'] as any;
      expect(state.Type).toBe('Task');
      expect(state.Resource).toContain('do-work');
      expect(state.Resource).toContain('arn:aws:lambda');
    });

    it('should generate default Retry config when no Camunda retries specified', () => {
      const process = makeProcess();
      const result = convertCamundaToASL(process);

      const state = result.stateMachine.States['DoWork'] as any;
      expect(state.Retry).toBeDefined();
      expect(state.Retry.length).toBeGreaterThan(0);
      expect(state.Retry[0].ErrorEquals).toContain('States.TaskFailed');
    });

    it('should generate Retry config from Camunda retry format (R3/PT5S)', () => {
      const process = makeProcess({
        elements: [
          { type: 'startEvent', id: 'Start_1', outgoing: ['Flow_1'] },
          { type: 'serviceTask', id: 'Task_1', name: 'Retry Task', topic: 'retry-task', taskType: 'external', retries: 'R3/PT5S', incoming: ['Flow_1'], outgoing: ['Flow_2'] } as ServiceTask,
          { type: 'endEvent', id: 'End_1', incoming: ['Flow_2'] },
        ],
      });
      const result = convertCamundaToASL(process);

      const state = result.stateMachine.States['RetryTask'] as any;
      expect(state.Retry).toBeDefined();
      expect(state.Retry[0].MaxAttempts).toBe(3);
      expect(state.Retry[0].IntervalSeconds).toBe(5);
      expect(state.Retry[0].BackoffRate).toBe(2.0);
    });

    it('should generate default Catch block when no boundary events exist', () => {
      const process = makeProcess();
      const result = convertCamundaToASL(process);

      const state = result.stateMachine.States['DoWork'] as any;
      expect(state.Catch).toBeDefined();
      expect(state.Catch[0].ErrorEquals).toContain('States.ALL');
      expect(state.Catch[0].Next).toBe('HandleError');
    });
  });

  // --- Boundary Event Handling ---

  describe('boundary event handling', () => {
    it('should generate Catch block from error boundary event with errorRef', () => {
      const process = makeProcess({
        elements: [
          { type: 'startEvent', id: 'Start_1', outgoing: ['Flow_1'] },
          { type: 'serviceTask', id: 'Task_1', name: 'Risky Task', topic: 'risky', taskType: 'external', incoming: ['Flow_1'], outgoing: ['Flow_2'] } as ServiceTask,
          { type: 'boundaryEvent', id: 'BE_1', attachedToRef: 'Task_1', cancelActivity: true, eventType: 'error', errorCode: 'MY_ERROR', outgoing: ['Flow_Err'] } as BoundaryEvent,
          { type: 'endEvent', id: 'End_1', incoming: ['Flow_2'] },
        ],
        sequenceFlows: [
          { id: 'Flow_1', sourceRef: 'Start_1', targetRef: 'Task_1' },
          { id: 'Flow_2', sourceRef: 'Task_1', targetRef: 'End_1' },
          { id: 'Flow_Err', sourceRef: 'BE_1', targetRef: 'End_1' },
        ],
      });
      const result = convertCamundaToASL(process);

      const state = result.stateMachine.States['RiskyTask'] as any;
      expect(state.Catch).toBeDefined();
      expect(state.Catch.some((c: any) => c.ErrorEquals.includes('MY_ERROR'))).toBe(true);
    });

    it('should generate TimeoutSeconds from timer boundary event duration', () => {
      const process = makeProcess({
        elements: [
          { type: 'startEvent', id: 'Start_1', outgoing: ['Flow_1'] },
          { type: 'serviceTask', id: 'Task_1', name: 'Timed Task', topic: 'timed', taskType: 'external', incoming: ['Flow_1'], outgoing: ['Flow_2'] } as ServiceTask,
          { type: 'boundaryEvent', id: 'BE_Timer', attachedToRef: 'Task_1', cancelActivity: true, eventType: 'timer', timerDuration: 'PT2M', outgoing: ['Flow_Timeout'] } as BoundaryEvent,
          { type: 'endEvent', id: 'End_1', incoming: ['Flow_2'] },
        ],
        sequenceFlows: [
          { id: 'Flow_1', sourceRef: 'Start_1', targetRef: 'Task_1' },
          { id: 'Flow_2', sourceRef: 'Task_1', targetRef: 'End_1' },
          { id: 'Flow_Timeout', sourceRef: 'BE_Timer', targetRef: 'End_1' },
        ],
      });
      const result = convertCamundaToASL(process);

      const state = result.stateMachine.States['TimedTask'] as any;
      expect(state.TimeoutSeconds).toBe(120); // PT2M = 120 seconds
    });
  });

  // --- Exclusive Gateway Conversion ---

  describe('exclusive gateway conversion', () => {
    it('should convert exclusive gateway to Choice state with string conditions', () => {
      const process = makeProcess({
        elements: [
          { type: 'startEvent', id: 'Start_1', outgoing: ['Flow_1'] },
          { type: 'exclusiveGateway', id: 'GW_1', name: 'Check Type', default: 'Flow_Default', incoming: ['Flow_1'], outgoing: ['Flow_Yes', 'Flow_Default'] } as any,
          { type: 'serviceTask', id: 'Task_Yes', name: 'Handle Yes', topic: 'yes', taskType: 'external', incoming: ['Flow_Yes'], outgoing: ['Flow_YesEnd'] } as ServiceTask,
          { type: 'serviceTask', id: 'Task_Default', name: 'Handle Default', topic: 'default', taskType: 'external', incoming: ['Flow_Default'], outgoing: ['Flow_DefaultEnd'] } as ServiceTask,
          { type: 'endEvent', id: 'End_1', incoming: ['Flow_YesEnd', 'Flow_DefaultEnd'] },
        ],
        sequenceFlows: [
          { id: 'Flow_1', sourceRef: 'Start_1', targetRef: 'GW_1' },
          { id: 'Flow_Yes', sourceRef: 'GW_1', targetRef: 'Task_Yes', conditionExpression: "${status == 'active'}" },
          { id: 'Flow_Default', sourceRef: 'GW_1', targetRef: 'Task_Default' },
          { id: 'Flow_YesEnd', sourceRef: 'Task_Yes', targetRef: 'End_1' },
          { id: 'Flow_DefaultEnd', sourceRef: 'Task_Default', targetRef: 'End_1' },
        ],
      });
      const result = convertCamundaToASL(process);

      const choiceState = result.stateMachine.States['CheckType'] as any;
      expect(choiceState.Type).toBe('Choice');
      expect(choiceState.Choices).toBeDefined();
      expect(choiceState.Choices.length).toBeGreaterThan(0);
      expect(choiceState.Choices[0].Variable).toBe('$.status');
      expect(choiceState.Choices[0].StringEquals).toBe('active');
      expect(choiceState.Default).toBeDefined();
    });
  });

  // --- Parallel Gateway Conversion ---

  describe('parallel gateway conversion', () => {
    it('should convert parallel gateway to Parallel state with branches', () => {
      const process = makeProcess({
        elements: [
          { type: 'startEvent', id: 'Start_1', outgoing: ['Flow_1'] },
          { type: 'parallelGateway', id: 'PG_Fork', name: 'Fork', incoming: ['Flow_1'], outgoing: ['Flow_B1', 'Flow_B2'] } as any,
          { type: 'serviceTask', id: 'Task_B1', name: 'Branch One', topic: 'branch-one', taskType: 'external', incoming: ['Flow_B1'], outgoing: ['Flow_B1Join'] } as ServiceTask,
          { type: 'serviceTask', id: 'Task_B2', name: 'Branch Two', topic: 'branch-two', taskType: 'external', incoming: ['Flow_B2'], outgoing: ['Flow_B2Join'] } as ServiceTask,
          { type: 'parallelGateway', id: 'PG_Join', name: 'Join', incoming: ['Flow_B1Join', 'Flow_B2Join'], outgoing: ['Flow_JoinEnd'] } as any,
          { type: 'endEvent', id: 'End_1', incoming: ['Flow_JoinEnd'] },
        ],
        sequenceFlows: [
          { id: 'Flow_1', sourceRef: 'Start_1', targetRef: 'PG_Fork' },
          { id: 'Flow_B1', sourceRef: 'PG_Fork', targetRef: 'Task_B1' },
          { id: 'Flow_B2', sourceRef: 'PG_Fork', targetRef: 'Task_B2' },
          { id: 'Flow_B1Join', sourceRef: 'Task_B1', targetRef: 'PG_Join' },
          { id: 'Flow_B2Join', sourceRef: 'Task_B2', targetRef: 'PG_Join' },
          { id: 'Flow_JoinEnd', sourceRef: 'PG_Join', targetRef: 'End_1' },
        ],
      });
      const result = convertCamundaToASL(process);

      const parallelState = result.stateMachine.States['Fork'] as any;
      expect(parallelState.Type).toBe('Parallel');
      expect(parallelState.Branches).toBeDefined();
      expect(parallelState.Branches.length).toBe(2);
    });
  });

  // --- User Task Conversion ---

  describe('user task conversion', () => {
    it('should convert user task to waitForTaskToken pattern', () => {
      const process = makeProcess({
        elements: [
          { type: 'startEvent', id: 'Start_1', outgoing: ['Flow_1'] },
          { type: 'userTask', id: 'Task_1', name: 'Approve Request', assignee: 'manager', candidateGroups: 'approvers', incoming: ['Flow_1'], outgoing: ['Flow_2'] } as any,
          { type: 'endEvent', id: 'End_1', incoming: ['Flow_2'] },
        ],
        sequenceFlows: [
          { id: 'Flow_1', sourceRef: 'Start_1', targetRef: 'Task_1' },
          { id: 'Flow_2', sourceRef: 'Task_1', targetRef: 'End_1' },
        ],
      });
      const result = convertCamundaToASL(process);

      const state = result.stateMachine.States['ApproveRequest'] as any;
      expect(state.Type).toBe('Task');
      expect(state.Resource).toContain('waitForTaskToken');
    });

    it('should include user task callback warning in conversion warnings', () => {
      const process = makeProcess({
        elements: [
          { type: 'startEvent', id: 'Start_1', outgoing: ['Flow_1'] },
          { type: 'userTask', id: 'Task_1', name: 'Review Doc', incoming: ['Flow_1'], outgoing: ['Flow_2'] } as any,
          { type: 'endEvent', id: 'End_1', incoming: ['Flow_2'] },
        ],
        sequenceFlows: [
          { id: 'Flow_1', sourceRef: 'Start_1', targetRef: 'Task_1' },
          { id: 'Flow_2', sourceRef: 'Task_1', targetRef: 'End_1' },
        ],
      });
      const result = convertCamundaToASL(process);

      expect(result.warnings.some(w => w.includes('waitForTaskToken') || w.includes('callback'))).toBe(true);
    });
  });

  // --- Unsupported Elements ---

  describe('unsupported elements', () => {
    it('should handle unsupported element types by generating Pass state with TODO comment', () => {
      const process = makeProcess({
        elements: [
          { type: 'startEvent', id: 'Start_1', outgoing: ['Flow_1'] },
          { type: 'subProcess' as any, id: 'Sub_1', name: 'My SubProcess', incoming: ['Flow_1'], outgoing: ['Flow_2'], elements: [], sequenceFlows: [] },
          { type: 'endEvent', id: 'End_1', incoming: ['Flow_2'] },
        ],
        sequenceFlows: [
          { id: 'Flow_1', sourceRef: 'Start_1', targetRef: 'Sub_1' },
          { id: 'Flow_2', sourceRef: 'Sub_1', targetRef: 'End_1' },
        ],
      });
      const result = convertCamundaToASL(process);

      const state = result.stateMachine.States['MySubProcess'] as any;
      expect(state.Type).toBe('Pass');
      expect(state.Comment).toContain('TODO');
    });

    it('should track unsupported constructs in metadata', () => {
      const process = makeProcess({
        elements: [
          { type: 'startEvent', id: 'Start_1', outgoing: ['Flow_1'] },
          { type: 'inclusiveGateway' as any, id: 'IG_1', name: 'Inclusive', incoming: ['Flow_1'], outgoing: ['Flow_2'] },
          { type: 'endEvent', id: 'End_1', incoming: ['Flow_2'] },
        ],
        sequenceFlows: [
          { id: 'Flow_1', sourceRef: 'Start_1', targetRef: 'IG_1' },
          { id: 'Flow_2', sourceRef: 'IG_1', targetRef: 'End_1' },
        ],
      });
      const result = convertCamundaToASL(process);

      expect(result.metadata.unsupportedConstructs).toContain('inclusiveGateway');
    });
  });

  // --- Terminal States ---

  describe('terminal states', () => {
    it('should generate WorkflowComplete (Succeed) state', () => {
      const process = makeProcess();
      const result = convertCamundaToASL(process);

      const state = result.stateMachine.States['WorkflowComplete'] as any;
      expect(state).toBeDefined();
      expect(state.Type).toBe('Succeed');
    });

    it('should generate HandleError (Fail) state', () => {
      const process = makeProcess();
      const result = convertCamundaToASL(process);

      const state = result.stateMachine.States['HandleError'] as any;
      expect(state).toBeDefined();
      expect(state.Type).toBe('Fail');
      expect(state.Error).toBeDefined();
      expect(state.Cause).toBeDefined();
    });
  });

  // --- Metadata ---

  describe('metadata', () => {
    it('should report correct source task count', () => {
      const process = makeProcess({
        elements: [
          { type: 'startEvent', id: 'Start_1', outgoing: ['Flow_1'] },
          { type: 'serviceTask', id: 'Task_1', name: 'Task A', topic: 'a', taskType: 'external', incoming: ['Flow_1'], outgoing: ['Flow_2'] } as ServiceTask,
          { type: 'serviceTask', id: 'Task_2', name: 'Task B', topic: 'b', taskType: 'external', incoming: ['Flow_2'], outgoing: ['Flow_3'] } as ServiceTask,
          { type: 'endEvent', id: 'End_1', incoming: ['Flow_3'] },
        ],
        sequenceFlows: [
          { id: 'Flow_1', sourceRef: 'Start_1', targetRef: 'Task_1' },
          { id: 'Flow_2', sourceRef: 'Task_1', targetRef: 'Task_2' },
          { id: 'Flow_3', sourceRef: 'Task_2', targetRef: 'End_1' },
        ],
      });
      const result = convertCamundaToASL(process);

      expect(result.metadata.sourceTaskCount).toBe(2);
    });

    it('should report correct generated state count', () => {
      const process = makeProcess();
      const result = convertCamundaToASL(process);

      // 1 task state + WorkflowComplete + HandleError = 3
      expect(result.metadata.generatedStateCount).toBe(3);
    });
  });

  // --- Expression Conversion ---

  describe('expression conversion', () => {
    it('should convert Camunda expressions (${variable}) to JsonPath ($.variable) in parameters', () => {
      const process = makeProcess({
        elements: [
          { type: 'startEvent', id: 'Start_1', outgoing: ['Flow_1'] },
          {
            type: 'serviceTask', id: 'Task_1', name: 'Expr Task', topic: 'expr',
            taskType: 'external',
            inputParameters: { fileId: '${fileId}', bucket: '${outputBucket}' },
            incoming: ['Flow_1'], outgoing: ['Flow_2'],
          } as ServiceTask,
          { type: 'endEvent', id: 'End_1', incoming: ['Flow_2'] },
        ],
        sequenceFlows: [
          { id: 'Flow_1', sourceRef: 'Start_1', targetRef: 'Task_1' },
          { id: 'Flow_2', sourceRef: 'Task_1', targetRef: 'End_1' },
        ],
      });
      const result = convertCamundaToASL(process);

      const state = result.stateMachine.States['ExprTask'] as any;
      expect(state.Parameters).toBeDefined();
      expect(state.Parameters['fileId.$']).toBe('$.fileId');
      expect(state.Parameters['bucket.$']).toBe('$.outputBucket');
    });
  });

  // --- Cycle Prevention ---

  describe('cycle prevention', () => {
    it('should handle cycles in graph without infinite loop (visited set)', () => {
      // Create a cycle: Start → Task_1 → Task_2 → Task_1 (cycle)
      const process = makeProcess({
        elements: [
          { type: 'startEvent', id: 'Start_1', outgoing: ['Flow_1'] },
          { type: 'serviceTask', id: 'Task_1', name: 'Loop A', topic: 'loop-a', taskType: 'external', incoming: ['Flow_1', 'Flow_Back'], outgoing: ['Flow_2'] } as ServiceTask,
          { type: 'serviceTask', id: 'Task_2', name: 'Loop B', topic: 'loop-b', taskType: 'external', incoming: ['Flow_2'], outgoing: ['Flow_Back'] } as ServiceTask,
          { type: 'endEvent', id: 'End_1', incoming: [] },
        ],
        sequenceFlows: [
          { id: 'Flow_1', sourceRef: 'Start_1', targetRef: 'Task_1' },
          { id: 'Flow_2', sourceRef: 'Task_1', targetRef: 'Task_2' },
          { id: 'Flow_Back', sourceRef: 'Task_2', targetRef: 'Task_1' }, // cycle
        ],
      });

      // Should not throw or hang — the visited set prevents infinite recursion
      const result = convertCamundaToASL(process);
      expect(result.stateMachine.States).toBeDefined();
      expect(Object.keys(result.stateMachine.States).length).toBeGreaterThan(0);
    });
  });
});
