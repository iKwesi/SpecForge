import { runGoldenDemoScript } from "../src/demo/goldenDemoScript.js";

async function main(): Promise<void> {
  process.exitCode = await runGoldenDemoScript(process.argv.slice(2));
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
