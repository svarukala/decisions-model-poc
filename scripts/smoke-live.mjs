import { classify, readConfig } from "../router.mjs";

const config = await readConfig();
if (!config.apiKey) throw new Error("Set TYPESAFE_API_KEY in .env before running the live smoke check.");
for (const prompt of [
  "Rewrite this sentence professionally: Please send the budget by Friday.",
  "Gather project updates from shared files, update the project tracker, and email the final report to the team.",
]) {
  const result = await classify({ prompt }, config);
  console.log(JSON.stringify({ prompt, ...result }, null, 2));
}
