#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { parseConductorWorkflow } from './parsers/conductor';
import { convertConductorToASL } from './mappers/conductor-to-asl';

const program = new Command();

program
  .name('workflow-migrator')
  .description('Convert workflow definitions from Netflix Conductor to AWS Step Functions ASL')
  .version('0.1.0');

program
  .command('convert')
  .description('Convert a workflow definition to Step Functions ASL')
  .requiredOption('--from <platform>', 'Source platform (conductor)')
  .requiredOption('--input <file>', 'Input workflow definition file')
  .option('--output <file>', 'Output ASL file (defaults to stdout)')
  .option('--pretty', 'Pretty-print the output JSON', true)
  .action((options) => {
    try {
      const { from, input, output, pretty } = options;

      // Validate source platform
      if (from !== 'conductor') {
        console.error(`Error: Unsupported source platform "${from}". Supported: conductor`);
        process.exit(1);
      }

      // Validate input file exists
      const inputPath = path.resolve(input);
      if (!fs.existsSync(inputPath)) {
        console.error(`Error: Input file not found: ${inputPath}`);
        process.exit(1);
      }

      // Parse the source workflow
      console.error(`\n🔄 Parsing ${from} workflow: ${path.basename(inputPath)}`);
      const workflow = parseConductorWorkflow(inputPath);
      console.error(`   Found ${workflow.tasks.length} tasks in workflow "${workflow.name}"`);

      // Convert to ASL
      console.error(`\n⚡ Converting to Step Functions ASL...`);
      const result = convertConductorToASL(workflow);

      // Output warnings
      if (result.warnings.length > 0) {
        console.error(`\n⚠️  Warnings (${result.warnings.length}):`);
        for (const warning of result.warnings) {
          console.error(`   • ${warning}`);
        }
      }

      // Output metadata
      console.error(`\n📊 Conversion Summary:`);
      console.error(`   Source tasks: ${result.metadata.sourceTaskCount}`);
      console.error(`   Generated states: ${result.metadata.generatedStateCount}`);
      if (result.metadata.unsupportedConstructs.length > 0) {
        console.error(
          `   Unsupported constructs: ${result.metadata.unsupportedConstructs.join(', ')}`
        );
      }

      // Write output
      const jsonOutput = pretty
        ? JSON.stringify(result.stateMachine, null, 2)
        : JSON.stringify(result.stateMachine);

      if (output) {
        const outputPath = path.resolve(output);
        fs.writeFileSync(outputPath, jsonOutput);
        console.error(`\n✅ ASL written to: ${outputPath}`);
      } else {
        // Write ASL to stdout (warnings/metadata go to stderr)
        console.log(jsonOutput);
      }

      console.error('');
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(2);
    }
  });

program
  .command('validate')
  .description('Validate a Conductor workflow definition without converting')
  .requiredOption('--input <file>', 'Input workflow definition file')
  .action((options) => {
    try {
      const inputPath = path.resolve(options.input);
      if (!fs.existsSync(inputPath)) {
        console.error(`Error: Input file not found: ${inputPath}`);
        process.exit(1);
      }

      const workflow = parseConductorWorkflow(inputPath);
      console.log(`✅ Valid Conductor workflow: "${workflow.name}" (v${workflow.version})`);
      console.log(`   Tasks: ${workflow.tasks.length}`);
      console.log(`   Task types: ${[...new Set(workflow.tasks.map((t) => t.type))].join(', ')}`);
      if (workflow.timeoutSeconds) {
        console.log(`   Timeout: ${workflow.timeoutSeconds}s`);
      }
    } catch (error: any) {
      console.error(`❌ Invalid workflow: ${error.message}`);
      process.exit(2);
    }
  });

program
  .command('supported')
  .description('List supported source platforms and construct mappings')
  .action(() => {
    console.log(`\nSupported Source Platforms:`);
    console.log(`  ✅ conductor  — Netflix Conductor JSON DSL`);
    console.log(`  🔜 camunda    — Camunda BPMN 2.0 XML (coming soon)`);
    console.log(`\nConductor Construct Mapping:`);
    console.log(`  ┌─────────────────────┬──────────────────────────────┐`);
    console.log(`  │ Conductor           │ Step Functions                │`);
    console.log(`  ├─────────────────────┼──────────────────────────────┤`);
    console.log(`  │ HTTP / SIMPLE       │ Task (Lambda Invoke)         │`);
    console.log(`  │ DECISION / SWITCH   │ Choice                       │`);
    console.log(`  │ FORK_JOIN           │ Parallel                     │`);
    console.log(`  │ JOIN                │ (implicit in Parallel)       │`);
    console.log(`  │ SUB_WORKFLOW        │ Task (StartExecution)        │`);
    console.log(`  │ WAIT                │ Wait                         │`);
    console.log(`  │ TERMINATE           │ Fail                         │`);
    console.log(`  │ DO_WHILE            │ Choice + loop pattern        │`);
    console.log(`  └─────────────────────┴──────────────────────────────┘`);
    console.log(`\nExpression Mapping:`);
    console.log(`  \${workflow.input.field}     → $.field`);
    console.log(`  \${taskRef.output.field}     → $.taskRef.field`);
    console.log(``);
  });

program.parse();
