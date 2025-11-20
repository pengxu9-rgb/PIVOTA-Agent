// Demo: GPT-5.1 -> pivota_shopping_tool -> local gateway -> Pivota API
import "dotenv/config";
import OpenAI from "openai";
import axios from "axios";
import { readFile } from "fs/promises";

const toolSchema = JSON.parse(
  await readFile(new URL("../docs/tool-schema.json", import.meta.url), "utf8"),
);

// Env vars expected:
//   OPENAI_API_KEY     - OpenAI key
//   PIVOTA_GATEWAY_URL - defaults to http://localhost:3000/agent/shop/v1/invoke
//   (gateway itself needs PIVOTA_API_BASE & PIVOTA_API_KEY when running)

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const GATEWAY_URL =
  process.env.PIVOTA_GATEWAY_URL ||
  "http://localhost:3000/agent/shop/v1/invoke";

async function callPivotaTool(args) {
  const res = await axios.post(GATEWAY_URL, args, {
    headers: { "Content-Type": "application/json" },
    timeout: 10000,
  });
  return res.data;
}

async function runDemo() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const messages = [
    {
      role: "system",
      content:
        "You are the Pivota Shopping Agent. Use the pivota_shopping_tool for any shopping, ordering, payment, or order-status task.",
    },
    {
      role: "user",
      content:
        "I want a pair of Nike running shoes under 800 CNY that can be shipped to Shanghai.",
    },
  ];

  while (true) {
    const completion = await client.chat.completions.create({
      model: "gpt-5.1",
      messages,
      tools: [
        {
          type: "function",
          function: toolSchema,
        },
      ],
      tool_choice: "auto",
    });

    const choice = completion.choices[0];
    const msg = choice.message;

    // Tool call path
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      messages.push(msg); // include assistant tool-call message in the history

      for (const toolCall of msg.tool_calls) {
        if (toolCall.type !== "function") continue;
        const { name, arguments: argStr } = toolCall.function;
        if (name !== "pivota_shopping_tool") continue;

        let args;
        try {
          args = JSON.parse(argStr || "{}");
        } catch (e) {
          console.error("Failed to parse tool arguments", e, argStr);
          return;
        }

        console.log("→ Tool call:", name, args);

        const toolResult = await callPivotaTool(args);

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name,
          content: JSON.stringify(toolResult),
        });
      }

      // Continue loop to let model consume tool results
      continue;
    }

    // Final answer path
    console.log("\nAssistant final answer:\n");
    console.log(msg.content);
    break;
  }
}

runDemo().catch((err) => {
  console.error("Demo error:", err);
  process.exit(1);
});
