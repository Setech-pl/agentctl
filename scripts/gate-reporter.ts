// Machine-readable Node test events; keep failures and the final aggregate, not timing heuristics.
export default async function* reporter(events: AsyncIterable<{ type: string; data: any }>) {
  for await (const event of events) {
    if (event.type === 'test:fail' || event.type === 'test:summary') yield `GATE_EVENT ${JSON.stringify(event)}\n`;
    if (event.type === 'test:stderr' || event.type === 'test:stdout') yield event.data.message;
  }
}
