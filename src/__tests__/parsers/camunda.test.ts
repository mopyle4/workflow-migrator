import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseCamundaWorkflow } from '../../parsers/camunda';
import { WorkflowMigratorError, ParseError, ValidationError, ErrorCode } from '../../utils/errors';
import { MAX_INPUT_FILE_SIZE_BYTES } from '../../utils/constants';
import { logger, LogLevel } from '../../utils/logger';

// Suppress logger output during tests
beforeAll(() => logger.setLevel(LogLevel.SILENT));

describe('parseCamundaWorkflow', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfm-camunda-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeBpmn(filename: string, content: string): string {
    const filePath = path.join(tmpDir, filename);
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  // --- Fixtures ---

  const MINIMAL_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn">
  <bpmn:process id="Process_1" name="Test Process" isExecutable="true">
    <bpmn:startEvent id="Start_1" name="Start">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:serviceTask id="Task_1" name="Do Work" camunda:type="external" camunda:topic="do-work">
      <bpmn:incoming>Flow_1</bpmn:incoming>
      <bpmn:outgoing>Flow_2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:endEvent id="End_1" name="Done">
      <bpmn:incoming>Flow_2</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_1" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="End_1" />
  </bpmn:process>
</bpmn:definitions>`;

  const BPMN_WITH_GATEWAY = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <bpmn:process id="Process_GW" name="Gateway Process" isExecutable="true">
    <bpmn:startEvent id="Start_1">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:exclusiveGateway id="GW_1" name="Check Status" default="Flow_Default">
      <bpmn:incoming>Flow_1</bpmn:incoming>
      <bpmn:outgoing>Flow_Yes</bpmn:outgoing>
      <bpmn:outgoing>Flow_Default</bpmn:outgoing>
    </bpmn:exclusiveGateway>
    <bpmn:serviceTask id="Task_Yes" name="Handle Yes" camunda:type="external" camunda:topic="handle-yes">
      <bpmn:incoming>Flow_Yes</bpmn:incoming>
      <bpmn:outgoing>Flow_YesEnd</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="Task_Default" name="Handle Default" camunda:type="external" camunda:topic="handle-default">
      <bpmn:incoming>Flow_Default</bpmn:incoming>
      <bpmn:outgoing>Flow_DefaultEnd</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:endEvent id="End_1">
      <bpmn:incoming>Flow_YesEnd</bpmn:incoming>
      <bpmn:incoming>Flow_DefaultEnd</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="GW_1" />
    <bpmn:sequenceFlow id="Flow_Yes" name="yes" sourceRef="GW_1" targetRef="Task_Yes">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">\${status == 'active'}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="Flow_Default" sourceRef="GW_1" targetRef="Task_Default" />
    <bpmn:sequenceFlow id="Flow_YesEnd" sourceRef="Task_Yes" targetRef="End_1" />
    <bpmn:sequenceFlow id="Flow_DefaultEnd" sourceRef="Task_Default" targetRef="End_1" />
  </bpmn:process>
</bpmn:definitions>`;

  const BPMN_WITH_BOUNDARY_EVENTS = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn">
  <bpmn:process id="Process_BE" name="Boundary Event Process" isExecutable="true">
    <bpmn:startEvent id="Start_1">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:serviceTask id="Task_1" name="Risky Task" camunda:type="external" camunda:topic="risky-task">
      <bpmn:incoming>Flow_1</bpmn:incoming>
      <bpmn:outgoing>Flow_2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:boundaryEvent id="BE_Error" name="Task Error" attachedToRef="Task_1">
      <bpmn:errorEventDefinition errorRef="Error_TaskFailed" />
      <bpmn:outgoing>Flow_ErrorHandler</bpmn:outgoing>
    </bpmn:boundaryEvent>
    <bpmn:boundaryEvent id="BE_Timer" name="Task Timeout" cancelActivity="true" attachedToRef="Task_1">
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration>PT30S</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
      <bpmn:outgoing>Flow_TimeoutHandler</bpmn:outgoing>
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="End_1">
      <bpmn:incoming>Flow_2</bpmn:incoming>
      <bpmn:incoming>Flow_ErrorHandler</bpmn:incoming>
      <bpmn:incoming>Flow_TimeoutHandler</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_1" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="End_1" />
    <bpmn:sequenceFlow id="Flow_ErrorHandler" sourceRef="BE_Error" targetRef="End_1" />
    <bpmn:sequenceFlow id="Flow_TimeoutHandler" sourceRef="BE_Timer" targetRef="End_1" />
  </bpmn:process>
</bpmn:definitions>`;

  const BPMN_WITH_EXTENSIONS = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn">
  <bpmn:process id="Process_Ext" name="Extension Process" isExecutable="true">
    <bpmn:startEvent id="Start_1">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:serviceTask id="Task_1" name="Extended Task" camunda:type="external" camunda:topic="extended-task">
      <bpmn:extensionElements>
        <camunda:inputOutput>
          <camunda:inputParameter name="inputFile">source.mp4</camunda:inputParameter>
          <camunda:inputParameter name="format">mp3</camunda:inputParameter>
          <camunda:outputParameter name="outputPath">result.mp3</camunda:outputParameter>
        </camunda:inputOutput>
      </bpmn:extensionElements>
      <bpmn:incoming>Flow_1</bpmn:incoming>
      <bpmn:outgoing>Flow_2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:endEvent id="End_1">
      <bpmn:incoming>Flow_2</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_1" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="End_1" />
  </bpmn:process>
</bpmn:definitions>`;

  const BPMN_WITH_PARALLEL_GATEWAY = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn">
  <bpmn:process id="Process_PG" name="Parallel Process" isExecutable="true">
    <bpmn:startEvent id="Start_1">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:parallelGateway id="PG_Fork" name="Fork">
      <bpmn:incoming>Flow_1</bpmn:incoming>
      <bpmn:outgoing>Flow_Branch1</bpmn:outgoing>
      <bpmn:outgoing>Flow_Branch2</bpmn:outgoing>
    </bpmn:parallelGateway>
    <bpmn:serviceTask id="Task_Branch1" name="Branch One" camunda:type="external" camunda:topic="branch-one">
      <bpmn:incoming>Flow_Branch1</bpmn:incoming>
      <bpmn:outgoing>Flow_B1ToJoin</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="Task_Branch2" name="Branch Two" camunda:type="external" camunda:topic="branch-two">
      <bpmn:incoming>Flow_Branch2</bpmn:incoming>
      <bpmn:outgoing>Flow_B2ToJoin</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:parallelGateway id="PG_Join" name="Join">
      <bpmn:incoming>Flow_B1ToJoin</bpmn:incoming>
      <bpmn:incoming>Flow_B2ToJoin</bpmn:incoming>
      <bpmn:outgoing>Flow_JoinToEnd</bpmn:outgoing>
    </bpmn:parallelGateway>
    <bpmn:endEvent id="End_1">
      <bpmn:incoming>Flow_JoinToEnd</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="PG_Fork" />
    <bpmn:sequenceFlow id="Flow_Branch1" sourceRef="PG_Fork" targetRef="Task_Branch1" />
    <bpmn:sequenceFlow id="Flow_Branch2" sourceRef="PG_Fork" targetRef="Task_Branch2" />
    <bpmn:sequenceFlow id="Flow_B1ToJoin" sourceRef="Task_Branch1" targetRef="PG_Join" />
    <bpmn:sequenceFlow id="Flow_B2ToJoin" sourceRef="Task_Branch2" targetRef="PG_Join" />
    <bpmn:sequenceFlow id="Flow_JoinToEnd" sourceRef="PG_Join" targetRef="End_1" />
  </bpmn:process>
</bpmn:definitions>`;

  // --- Happy Path ---

  describe('happy path', () => {
    it('should parse a valid minimal BPMN workflow', () => {
      const filePath = writeBpmn('minimal.bpmn', MINIMAL_BPMN);
      const result = parseCamundaWorkflow(filePath);

      expect(result.id).toBe('Process_1');
      expect(result.name).toBe('Test Process');
      expect(result.isExecutable).toBe(true);
      expect(result.elements.length).toBeGreaterThan(0);
      expect(result.sequenceFlows.length).toBeGreaterThan(0);
    });

    it('should parse BPMN with service tasks, gateways, and boundary events', () => {
      const filePath = writeBpmn('gateway.bpmn', BPMN_WITH_GATEWAY);
      const result = parseCamundaWorkflow(filePath);

      expect(result.elements.some(e => e.type === 'startEvent')).toBe(true);
      expect(result.elements.some(e => e.type === 'exclusiveGateway')).toBe(true);
      expect(result.elements.some(e => e.type === 'serviceTask')).toBe(true);
      expect(result.elements.some(e => e.type === 'endEvent')).toBe(true);
    });

    it('should extract correct element types', () => {
      const filePath = writeBpmn('boundary.bpmn', BPMN_WITH_BOUNDARY_EVENTS);
      const result = parseCamundaWorkflow(filePath);

      const types = result.elements.map(e => e.type);
      expect(types).toContain('startEvent');
      expect(types).toContain('endEvent');
      expect(types).toContain('serviceTask');
      expect(types).toContain('boundaryEvent');
    });

    it('should extract parallel gateway elements', () => {
      const filePath = writeBpmn('parallel.bpmn', BPMN_WITH_PARALLEL_GATEWAY);
      const result = parseCamundaWorkflow(filePath);

      const parallelGateways = result.elements.filter(e => e.type === 'parallelGateway');
      expect(parallelGateways.length).toBe(2); // Fork + Join
    });
  });

  // --- Sequence Flows ---

  describe('sequence flows', () => {
    it('should extract sequence flows with source and target refs', () => {
      const filePath = writeBpmn('flows.bpmn', MINIMAL_BPMN);
      const result = parseCamundaWorkflow(filePath);

      expect(result.sequenceFlows).toHaveLength(2);
      expect(result.sequenceFlows[0].sourceRef).toBe('Start_1');
      expect(result.sequenceFlows[0].targetRef).toBe('Task_1');
      expect(result.sequenceFlows[1].sourceRef).toBe('Task_1');
      expect(result.sequenceFlows[1].targetRef).toBe('End_1');
    });

    it('should extract condition expressions from sequence flows', () => {
      const filePath = writeBpmn('conditions.bpmn', BPMN_WITH_GATEWAY);
      const result = parseCamundaWorkflow(filePath);

      const conditionalFlow = result.sequenceFlows.find(f => f.id === 'Flow_Yes');
      expect(conditionalFlow).toBeDefined();
      expect(conditionalFlow!.conditionExpression).toContain("status == 'active'");
    });

    it('should extract flow names', () => {
      const filePath = writeBpmn('named-flows.bpmn', BPMN_WITH_GATEWAY);
      const result = parseCamundaWorkflow(filePath);

      const namedFlow = result.sequenceFlows.find(f => f.name === 'yes');
      expect(namedFlow).toBeDefined();
    });
  });

  // --- Camunda Extensions ---

  describe('Camunda extensions', () => {
    it('should extract external task topic', () => {
      const filePath = writeBpmn('topic.bpmn', MINIMAL_BPMN);
      const result = parseCamundaWorkflow(filePath);

      const serviceTask = result.elements.find(e => e.type === 'serviceTask') as any;
      expect(serviceTask).toBeDefined();
      expect(serviceTask.topic).toBe('do-work');
    });

    it('should extract input/output parameters from extension elements', () => {
      const filePath = writeBpmn('extensions.bpmn', BPMN_WITH_EXTENSIONS);
      const result = parseCamundaWorkflow(filePath);

      const serviceTask = result.elements.find(e => e.type === 'serviceTask') as any;
      expect(serviceTask).toBeDefined();
      expect(serviceTask.inputParameters).toBeDefined();
      expect(serviceTask.inputParameters.inputFile).toBe('source.mp4');
      expect(serviceTask.inputParameters.format).toBe('mp3');
      expect(serviceTask.outputParameters).toBeDefined();
      expect(serviceTask.outputParameters.outputPath).toBe('result.mp3');
    });

    it('should extract task type as external', () => {
      const filePath = writeBpmn('tasktype.bpmn', MINIMAL_BPMN);
      const result = parseCamundaWorkflow(filePath);

      const serviceTask = result.elements.find(e => e.type === 'serviceTask') as any;
      expect(serviceTask.taskType).toBe('external');
    });
  });

  // --- Boundary Events ---

  describe('boundary events', () => {
    it('should extract error boundary event with errorRef', () => {
      const filePath = writeBpmn('error-boundary.bpmn', BPMN_WITH_BOUNDARY_EVENTS);
      const result = parseCamundaWorkflow(filePath);

      const errorBoundary = result.elements.find(
        e => e.type === 'boundaryEvent' && e.id === 'BE_Error'
      ) as any;
      expect(errorBoundary).toBeDefined();
      expect(errorBoundary.eventType).toBe('error');
      expect(errorBoundary.errorCode).toBe('Error_TaskFailed');
      expect(errorBoundary.attachedToRef).toBe('Task_1');
    });

    it('should extract timer boundary event with duration', () => {
      const filePath = writeBpmn('timer-boundary.bpmn', BPMN_WITH_BOUNDARY_EVENTS);
      const result = parseCamundaWorkflow(filePath);

      const timerBoundary = result.elements.find(
        e => e.type === 'boundaryEvent' && e.id === 'BE_Timer'
      ) as any;
      expect(timerBoundary).toBeDefined();
      expect(timerBoundary.eventType).toBe('timer');
      expect(timerBoundary.timerDuration).toBe('PT30S');
      expect(timerBoundary.cancelActivity).toBe(true);
    });
  });

  // --- Error Cases ---

  describe('error cases', () => {
    it('should throw ParseError for invalid XML', () => {
      // fast-xml-parser is lenient with malformed XML, so we use content that
      // triggers a parse error rather than a downstream validation error.
      // An unclosed CDATA section reliably causes a parse failure.
      const filePath = writeBpmn('invalid.bpmn', '<?xml version="1.0"?><root><![CDATA[unclosed');

      expect(() => parseCamundaWorkflow(filePath)).toThrow(ParseError);
    });

    it('should throw ValidationError for missing process element', () => {
      const bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
</bpmn:definitions>`;
      const filePath = writeBpmn('no-process.bpmn', bpmn);

      expect(() => parseCamundaWorkflow(filePath)).toThrow(ValidationError);
      try {
        parseCamundaWorkflow(filePath);
      } catch (e: any) {
        expect(e.code).toBe(ErrorCode.VALIDATION_ERROR);
        expect(e.message).toContain('process');
      }
    });

    it('should throw ValidationError for missing start event', () => {
      const bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn">
  <bpmn:process id="Process_1" name="No Start" isExecutable="true">
    <bpmn:serviceTask id="Task_1" name="Orphan Task" camunda:type="external" camunda:topic="orphan">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:endEvent id="End_1">
      <bpmn:incoming>Flow_1</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Task_1" targetRef="End_1" />
  </bpmn:process>
</bpmn:definitions>`;
      const filePath = writeBpmn('no-start.bpmn', bpmn);

      expect(() => parseCamundaWorkflow(filePath)).toThrow(ValidationError);
      try {
        parseCamundaWorkflow(filePath);
      } catch (e: any) {
        expect(e.message).toContain('start event');
      }
    });

    it('should throw WorkflowMigratorError FILE_NOT_FOUND for missing file', () => {
      expect(() => parseCamundaWorkflow('/nonexistent/path/workflow.bpmn')).toThrow(WorkflowMigratorError);

      try {
        parseCamundaWorkflow('/nonexistent/path/workflow.bpmn');
      } catch (e: any) {
        expect(e.code).toBe(ErrorCode.FILE_NOT_FOUND);
      }
    });

    it('should throw WorkflowMigratorError FILE_TOO_LARGE for oversized file', () => {
      const filePath = path.join(tmpDir, 'large.bpmn');
      // Create a file just over the limit
      const largeContent = 'x'.repeat(MAX_INPUT_FILE_SIZE_BYTES + 1);
      fs.writeFileSync(filePath, largeContent);

      expect(() => parseCamundaWorkflow(filePath)).toThrow(WorkflowMigratorError);

      try {
        parseCamundaWorkflow(filePath);
      } catch (e: any) {
        expect(e.code).toBe(ErrorCode.FILE_TOO_LARGE);
      }
    });
  });

  // --- Edge Cases ---

  describe('edge cases', () => {
    it('should handle BPMN without bpmn: prefix', () => {
      const bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:camunda="http://camunda.org/schema/1.0/bpmn">
  <process id="Process_NP" name="No Prefix Process" isExecutable="true">
    <startEvent id="Start_1">
      <outgoing>Flow_1</outgoing>
    </startEvent>
    <serviceTask id="Task_1" name="Simple Task" camunda:type="external" camunda:topic="simple">
      <incoming>Flow_1</incoming>
      <outgoing>Flow_2</outgoing>
    </serviceTask>
    <endEvent id="End_1">
      <incoming>Flow_2</incoming>
    </endEvent>
    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_1" />
    <sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="End_1" />
  </process>
</definitions>`;
      const filePath = writeBpmn('no-prefix.bpmn', bpmn);
      const result = parseCamundaWorkflow(filePath);

      expect(result.id).toBe('Process_NP');
      expect(result.name).toBe('No Prefix Process');
      expect(result.elements.some(e => e.type === 'startEvent')).toBe(true);
      expect(result.elements.some(e => e.type === 'serviceTask')).toBe(true);
    });

    it('should handle multiple processes and pick the executable one', () => {
      const bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn">
  <bpmn:process id="Process_NonExec" name="Non Executable" isExecutable="false">
    <bpmn:startEvent id="Start_NE">
      <bpmn:outgoing>Flow_NE</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:endEvent id="End_NE">
      <bpmn:incoming>Flow_NE</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_NE" sourceRef="Start_NE" targetRef="End_NE" />
  </bpmn:process>
  <bpmn:process id="Process_Exec" name="Executable Process" isExecutable="true">
    <bpmn:startEvent id="Start_E">
      <bpmn:outgoing>Flow_E1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:serviceTask id="Task_E" name="Exec Task" camunda:type="external" camunda:topic="exec-task">
      <bpmn:incoming>Flow_E1</bpmn:incoming>
      <bpmn:outgoing>Flow_E2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:endEvent id="End_E">
      <bpmn:incoming>Flow_E2</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_E1" sourceRef="Start_E" targetRef="Task_E" />
    <bpmn:sequenceFlow id="Flow_E2" sourceRef="Task_E" targetRef="End_E" />
  </bpmn:process>
</bpmn:definitions>`;
      const filePath = writeBpmn('multi-process.bpmn', bpmn);
      const result = parseCamundaWorkflow(filePath);

      expect(result.id).toBe('Process_Exec');
      expect(result.name).toBe('Executable Process');
      expect(result.isExecutable).toBe(true);
    });
  });
});
