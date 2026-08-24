const name = Deno.args[0];
if (!name) {
  console.error("Usage: new-migration.ts <name>");
  console.error("Example: new-migration.ts add_studio_project_link");
  Deno.exit(1);
}

const timestamp = new Date()
  .toISOString()
  .replace(/[-:T]/g, "")
  .slice(0, 14);

const upFile = `migrations/${timestamp}_${name}.up.sql`;
const downFile = `migrations/${timestamp}_${name}.down.sql`;

await Deno.writeTextFile(upFile, `-- ${timestamp}_${name}.up.sql\n\n`);
await Deno.writeTextFile(downFile, `-- ${timestamp}_${name}.down.sql\n\n`);

console.log(`Created:\n  ${upFile}\n  ${downFile}`);
