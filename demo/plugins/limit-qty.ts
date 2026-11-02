export {};
// Sample plugged-in check: reject any order line with more than 100 units.
// Reads JSON on stdin, prints {"pass": true|false, "reason"?: string}.
const input = await Bun.stdin.json();
const items: { sku: string; qty: number }[] = input.result?.items ?? [];
const bad = items.find((i) => i.qty > 100);
console.log(JSON.stringify(bad ? { pass: false, reason: `${bad.sku}: qty ${bad.qty} is over the limit of 100` } : { pass: true }));
