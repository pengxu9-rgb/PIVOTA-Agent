// Demo: order status -> refund (after-sales) via pivota_shopping_tool -> gateway -> mock/real Pivota
import "dotenv/config";
import OpenAI from "openai";
import axios from "axios";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadToolSchema() {
  const schemaPath = path.join(__dirname, "..", "docs", "tool-schema.json");
  const raw = await fs.readFile(schemaPath, "utf-8");
  return JSON.parse(raw);
}

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

// Execute a dialogue round (may include tool calls) until assistant returns plain text.
async function runRound({ label, messages, toolSchema }) {
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

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const toolCall of msg.tool_calls) {
        if (toolCall.type !== "function") continue;
        const { name, arguments: argStr } = toolCall.function;
        if (name !== "pivota_shopping_tool") continue;

        let args;
        try {
          args = JSON.parse(argStr || "{}");
        } catch (e) {
          console.error("Failed to parse tool arguments", e, argStr);
          throw e;
        }

        console.log(`\n[${label}] → Tool call:`, name, args);

        const toolResult = await callPivotaTool(args);

        messages.push(msg);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name,
          content: JSON.stringify(toolResult),
        });
      }
      continue; // let model see tool results
    }

    console.log(`\n[${label}] Assistant answer:\n`);
    console.log(msg.content);
    messages.push(msg);
    break;
  }
}

async function runDemo() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const toolSchema = await loadToolSchema();
  const systemPrompt =
    "You are the Pivota Shopping Agent. Use the `pivota_shopping_tool` for any order status or after-sales task (refund/return/exchange/support).";

  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content:
        "I placed an order with ID mock_ord_123 yesterday. Can you check the current status?",
    },
  ];

  await runRound({ label: "Status check", messages, toolSchema });

  messages.push({
    role: "user",
    content:
      "I'm not satisfied with this order. Please help me request a refund for order mock_ord_123.",
  });

  await runRound({ label: "After-sales (refund)", messages, toolSchema });
}

runDemo().catch((err) => {
  console.error("Status demo error:", err);
  process.exit(1);
});
