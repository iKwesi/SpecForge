import { Command } from "commander";

const program = new Command();

program
  .name("specforge")
  .description("Specification-driven engineering orchestration CLI")
  .version("0.1.0");

program
  .command("start")
  .description("Start a SpecForge run (scaffold placeholder)")
  .action(() => {
    process.stdout.write("SpecForge CLI scaffold ready.\n");
  });

program.parse(process.argv);

