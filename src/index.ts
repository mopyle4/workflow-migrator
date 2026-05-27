#!/usr/bin/env node

/**
 * workflow-migrator CLI
 *
 * Converts workflow definitions from Netflix Conductor (and other platforms)
 * to AWS Step Functions Amazon States Language (ASL).
 *
 * Architecture: Command pattern (via Commander.js) with Strategy pattern
 * for platform-specific parsers and mappers.
 *
 * @see README.md for usage examples
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { parseConductorWorkflow } from './parsers/conductor';
import { parseCamundaWorkflow } from './parsers/camunda';
import { convertConductorToASL } from './mappers/conductor-to-asl';
import { convertCamundaToASL } from './mappers/camunda-to-asl';
import { logger, LogLevel } from './utils/logger';
import { WorkflowMigratorError, getExitCode } from './utils/errors';
import { SUPPORTED_PLATFORMS } from './utils/constants';

const program = new Command();

program
  .name('workflow-migrator')
  .description('Convert workflow definitions from Netflix Conductor to AWS Step Functions ASL')
  .version('0.1.0')
  .option('-v, --verbose', 'Enable verbose (debug) logging')
  .option('-q, --quiet', 'Suppress all output except errors and ASL')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.quiet) {
      logger.setLevel(LogLevel.ERROR);
    } else if (opts.verbose) {
      logger.setLevel(LogLevel.DEBUG);
    }
  });

program
  .command('convert')
  .description('Convert a workflow definition to Step Functions ASL')
  .requiredOption('--from <platform>', `Source platform (${SUPPORTED_PLATFORMS.join(', ')})`)
  .requiredOption('--input <file>', 'Input workflow definition file')
  .option('--output <file>', 'Output ASL file (defaults to stdout)')
  .option('--no-pretty', 'Disable pretty-printing of output JSON')
  .action((options) => {
    const { from, input, output, pretty } = options;

    try {
      // Validate source platform
      if (!SUPPORTED_PLATFORMS.includes(from)) {
        logger.error(`Unsupported source platform: "${from}"`, {
          supported: SUPPORTED_PLATFORMS,
        });
        process.exit(1);
      }

      // Resolve input path
      const inputPath = path.resolve(input);

      // Parse the source workflow
      logger.info(`Parsing ${from} workflow: ${path.basename(inputPath)}`);

      let result;
      if (from === 'conductor') {
        const workflow = parseConductorWorkflow(inputPath);
        logger.info(`Found ${workflow.tasks.length} tasks in workflow "${workflow.name}"`);
        logger.info('Converting to Step Functions ASL...');
        result = convertConductorToASL(workflow);
      } else if (from === 'camunda') {
        const bpmnProcess = parseCamundaWorkflow(inputPath);
        logger.info(`Found ${bpmnProcess.elements.length} elements in process "${bpmnProcess.name}"`);
        logger.info('Converting to Step Functions ASL...');
        result = convertCamundaToASL(bpmnProcess);
      } else {
        logger.error(`Unsupported platform: "${from}"`);
        process.exit(1);
        return;
      }

      // Output warnings
      if (result.warnings.length > 0) {
        logger.warn(`${result.warnings.length} conversion warning(s):`);
        for (const warning of result.warnings) {
          logger.warn(`  ${warning}`);
        }
      }

      // Output metadata
      logger.info('Conversion complete', {
        sourceTasks: result.metadata.sourceTaskCount,
        generatedStates: result.metadata.generatedStateCount,
        unsupported: result.metadata.unsupportedConstructs,
      });

      // Write output
      const jsonOutput = pretty !== false
        ? JSON.stringify(result.stateMachine, null, 2)
        : JSON.stringify(result.stateMachine);

      if (output) {
        const outputPath = path.resolve(output);
        fs.writeFileSync(outputPath, jsonOutput, 'utf-8');
        logger.info(`ASL written to: ${outputPath}`);
      } else {
        // Write ASL to stdout (all other output goes to stderr via logger)
        process.stdout.write(jsonOutput + '\n');
      }
    } catch (error: unknown) {
      handleError(error);
    }
  });

program
  .command('validate')
  .description('Validate a Conductor workflow definition without converting')
  .requiredOption('--input <file>', 'Input workflow definition file')
  .action((options) => {
    try {
      const inputPath = path.resolve(options.input);
      const workflow = parseConductorWorkflow(inputPath);

      logger.info(`Valid Conductor workflow: "${workflow.name}" (v${workflow.version})`);
      logger.info(`Tasks: ${workflow.tasks.length}`);
      logger.info(`Task types: ${[...new Set(workflow.tasks.map((t) => t.type))].join(', ')}`);

      if (workflow.timeoutSeconds) {
        logger.info(`Timeout: ${workflow.timeoutSeconds}s`);
      }
    } catch (error: unknown) {
      handleError(error);
    }
  });

program
  .command('supported')
  .description('List supported source platforms and construct mappings')
  .action(() => {
    const output = `
Supported Source Platforms:
  ✅ conductor  — Netflix Conductor JSON DSL
  ✅ camunda    — Camunda BPMN 2.0 XML (Camunda 7)

Conductor → Step Functions Construct Mapping:
  ┌─────────────────────┬──────────────────────────────┐
  │ Conductor           │ Step Functions                │
  ├─────────────────────┼──────────────────────────────┤
  │ HTTP / SIMPLE       │ Task (Lambda Invoke)         │
  │ DECISION / SWITCH   │ Choice                       │
  │ FORK_JOIN           │ Parallel                     │
  │ JOIN                │ (implicit in Parallel)       │
  │ SUB_WORKFLOW        │ Task (StartExecution)        │
  │ WAIT                │ Wait                         │
  │ TERMINATE           │ Fail                         │
  │ DO_WHILE            │ Choice + loop pattern        │
  └─────────────────────┴──────────────────────────────┘

Camunda → Step Functions Construct Mapping:
  ┌─────────────────────────────┬──────────────────────────────┐
  │ Camunda BPMN                │ Step Functions                │
  ├─────────────────────────────┼──────────────────────────────┤
  │ Start Event                 │ StartAt (implicit)           │
  │ Service Task (external)     │ Task (Lambda Invoke)         │
  │ User Task                   │ Task (waitForTaskToken)      │
  │ Exclusive Gateway (XOR)     │ Choice                       │
  │ Parallel Gateway (AND)      │ Parallel                     │
  │ Timer Boundary Event        │ TimeoutSeconds               │
  │ Error Boundary Event        │ Catch block                  │
  │ End Event                   │ Succeed                      │
  └─────────────────────────────┴──────────────────────────────┘

Expression Mapping:
  Conductor: \${workflow.input.field}     → $.field
  Conductor: \${taskRef.output.field}     → $.taskRef.field
  Camunda:   \${variable}                 → $.variable
  Camunda:   \${execution.variable}       → $.variable
`;
    process.stdout.write(output);
  });

/**
 * Centralized error handler with structured output and appropriate exit codes.
 */
function handleError(error: unknown): never {
  if (error instanceof WorkflowMigratorError) {
    logger.error(error.message, error.context);
    process.exit(getExitCode(error));
  }

  if (error instanceof Error) {
    logger.error(`Unexpected error: ${error.message}`);
    logger.debug('Stack trace', { stack: error.stack });
    process.exit(99);
  }

  logger.error('An unknown error occurred');
  process.exit(99);
}

program.parse();
