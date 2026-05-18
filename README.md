# workflow-migrator

Convert workflow definitions from Netflix Conductor (and other platforms) to AWS Step Functions ASL.

## The Problem

Migrating from workflow orchestration platforms to AWS Step Functions requires manually translating workflow definitions — mapping platform-specific constructs to Amazon States Language (ASL). This tool automates that translation.

## Supported Platforms

| Platform | Status | Input Format |
|---|---|---|
| Netflix Conductor | ✅ Supported | JSON DSL |
| Camunda BPM | 🔜 Coming soon | BPMN 2.0 XML |
| Temporal | 🔜 Planned | — |

## Installation

```bash
npm install -g workflow-migrator
```

Or run directly with npx:

```bash
npx workflow-migrator convert --from conductor --input workflow.json --output state-machine.asl.json
```

## Usage

### Convert a Conductor workflow to Step Functions

```bash
workflow-migrator convert --from conductor --input my-workflow.json --output my-state-machine.asl.json
```

### Validate a workflow definition

```bash
workflow-migrator validate --input my-workflow.json
```

### View supported platforms and construct mappings

```bash
workflow-migrator supported
```

## Construct Mapping (Conductor → Step Functions)

| Conductor | Step Functions |
|---|---|
| HTTP / SIMPLE | Task (Lambda Invoke) |
| DECISION / SWITCH | Choice |
| FORK_JOIN | Parallel |
| JOIN | (implicit in Parallel) |
| SUB_WORKFLOW | Task (StartExecution) |
| WAIT | Wait |
| TERMINATE | Fail |
| DO_WHILE | Choice + loop pattern |

## Expression Mapping

| Conductor | Step Functions (JsonPath) |
|---|---|
| `${workflow.input.field}` | `$.field` |
| `${taskRef.output.response.body.field}` | `$.taskRef.field` |

## Example

**Input (Conductor JSON DSL):**
```json
{
  "name": "media_processing_workflow",
  "tasks": [
    {
      "name": "extract_media_info",
      "taskReferenceName": "media_info",
      "type": "HTTP",
      "timeoutSeconds": 120,
      "inputParameters": {
        "http_request": {
          "uri": "${workflow.input.apiEndpoint}media-info",
          "method": "POST",
          "body": {
            "mediaFile": "${workflow.input.mediaFile}"
          }
        }
      }
    }
  ]
}
```

**Output (Step Functions ASL):**
```json
{
  "Comment": "Migrated from Conductor workflow: media_processing_workflow (v1)",
  "StartAt": "MediaInfo",
  "States": {
    "MediaInfo": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:extract_media_info",
      "Parameters": {
        "mediaFile.$": "$.mediaFile"
      },
      "TimeoutSeconds": 120,
      "Next": "WorkflowComplete"
    },
    "WorkflowComplete": {
      "Type": "Succeed"
    }
  }
}
```

## What This Tool Does NOT Do

- **Does not migrate business logic** — Your task worker code (Lambda functions) still needs manual migration
- **Does not deploy infrastructure** — It generates ASL definitions; you deploy them with CDK/SAM/CloudFormation
- **Does not handle runtime state** — In-flight workflow executions need to complete on Conductor before cutover

## Development

```bash
git clone <repo-url>
cd workflow-migrator
npm install
npm run build
npm run test
```

## Related Resources

- [Migrating from Netflix Conductor to AWS Step Functions](link-to-blog) — Comprehensive migration guide
- [AWS Step Functions Documentation](https://docs.aws.amazon.com/step-functions/latest/dg/)
- [Amazon States Language Specification](https://states-language.net/spec.html)

## License

MIT
