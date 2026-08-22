
import { config } from 'dotenv';
config({ path: '.env.local' });                    // load your keys for a plain script

import { readFileSync, writeFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const PARSE_PROMPT = `You convert a short freeform cooking log into structured JSON.
Return ONLY a JSON object — no markdown, no preamble — with:
- dish: string (normalized dish name)
- changes: string or null (the experimental variable — what they did differently)
- outcome: string or null (what actually happened)
- analysis: string or null (their interpretation — hypotheses, what caused the result,
  what they're unsure about, what to try next; preserve their reasoning, don't flatten it)
- rating: integer 1–10 or null (their score, if given)
If the message is NOT about something they cooked, return exactly: {"skip": true}`;

async function parseLine(message: string) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: PARSE_PROMPT }] },
        contents: [{ parts: [{ text: message }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 300, temperature: 0 },
      }),
    },
  );
  const data = await res.json();
  return JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}');
}

async function main() {
  const mode = process.argv[2];

  if (mode === 'parse') {
    const lines = readFileSync('./journey.txt', 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
    const results: any[] = [];
    let ok = 0, skipped = 0;
    for (const [i, line] of lines.entries()) {
      try {
        const p = await parseLine(line);
        if (p.skip || !p.dish) { skipped++; console.log(`  skip [${i + 1}/${lines.length}] ${line.slice(0, 50)}`); }
        else { results.push({ line, parsed: p }); ok++; console.log(`  ok   [${i + 1}/${lines.length}] ${p.dish}`); }
      } catch (e: any) {
        skipped++; console.error(`  ERR  [${i + 1}/${lines.length}] ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 4500));   // stay under Gemini free ~15 rpm
    }
    writeFileSync('./parsed.json', JSON.stringify(results, null, 2));
    console.log(`\n${lines.length} lines → ${ok} parsed, ${skipped} skipped.`);
    console.log(`OPEN parsed.json, read it, fix anything wrong, THEN run import.`);
  } else if (mode === 'import') {
    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
    const entries = JSON.parse(readFileSync('./parsed.json', 'utf8'));
    const rows = entries.map(({ line, parsed }: any) => ({
      dish: parsed.dish,
      changes: parsed.changes ?? null,
      outcome: parsed.outcome ?? null,
      analysis: parsed.analysis ?? null,
      rating: parsed.rating ?? null,
      note: line,
      source: 'import',
    }));
    const { error } = await supabase.from('attempts').insert(rows);
    if (error) { console.error('Insert failed:', error.message); process.exit(1); }
    console.log(`Inserted ${rows.length} rows (source='import').`);
  } else {
    console.error('Usage: npx tsx scripts/import-journey.ts <parse|import>');
    process.exit(1);
  }
}
main();