#!/usr/bin/env node
// A stand-in for the agy CLI, driven by environment variables:
//   FAKE_AGY_MODELS        output for `agy models` (default: a Carbon-capable listing)
//   FAKE_AGY_REFUSE_MODELS comma list of model ids to refuse with agy's real quota error;
//                          the token `default` refuses runs that pass no --model
//   FAKE_AGY_RESPONSE      response text (default: "fake agy response")
//   FAKE_AGY_STRUCTURED    JSON to return as structured_output
//   FAKE_AGY_LOG           file that receives one JSON line of argv per call
import fs from 'node:fs';

const argv = process.argv.slice(2);
if (process.env.FAKE_AGY_LOG) fs.appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify(argv)}\n`);

if (argv[0] === 'models') {
  // Like the real agy, the banner goes to stderr and the listing to stdout.
  process.stderr.write('Fetching available models...\n');
  process.stdout.write(
    process.env.FAKE_AGY_MODELS ??
      'gemini-4-carbon-medium\tGemini 4 Carbon (Medium)\ngemini-4-carbon-high\tGemini 4 Carbon (High)\ngemini-4-carbon-low\tGemini 4 Carbon (Low)\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n',
  );
  process.exit(0);
}
if (argv[0] === '--version') {
  process.stdout.write('1.5.9\n');
  process.exit(0);
}

const modelIndex = argv.indexOf('--model');
const model = modelIndex === -1 ? 'default' : argv[modelIndex + 1];
const refused = (process.env.FAKE_AGY_REFUSE_MODELS ?? '').split(',').filter(Boolean);
if (refused.includes(model)) {
  const message = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 54h55m0s.';
  process.stderr.write(`error: ${message}\n`);
  process.stderr.write(
    `AGY_ERROR: ${JSON.stringify({
      short_error: `RESOURCE_EXHAUSTED (code 429): ${message}`,
      status: 'RESOURCE_EXHAUSTED',
      error_code: 429,
      code_kind: 'http',
      retryable: true,
    })}\n`,
  );
  process.exit(3);
}

const payload = {
  conversation_id: 'conv-fake',
  status: 'SUCCESS',
  response: process.env.FAKE_AGY_RESPONSE ?? 'fake agy response',
  duration_seconds: 0.1,
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};
if (process.env.FAKE_AGY_STRUCTURED) payload.structured_output = JSON.parse(process.env.FAKE_AGY_STRUCTURED);
process.stdout.write(`${JSON.stringify(payload)}\n`);
