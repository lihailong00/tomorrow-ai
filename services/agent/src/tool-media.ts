/** Remove image payloads from machine-readable MCP menus, preserving all business data. */
export function compactMcpMedia(input: unknown): unknown {
  let omitted = 0, visited = 0;
  const mediaKey = /^(?:images?|imgs?|pics?|pictures?|thumbnails?|logos?|icons?|banners?)(?:url|urls|path|src)?$/i;
  const imageValue = (value: unknown): boolean => typeof value === 'string' && /^(?:https?:\/\/|data:image\/)/i.test(value) ||
    Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && /^(?:https?:\/\/|data:image\/)/i.test(item));
  const walk = (value: unknown, depth = 0): unknown => {
    if (++visited > 50000 || depth > 30) return value;
    if (Array.isArray(value)) return value.map(item => walk(item, depth + 1));
    if (!value || typeof value !== 'object') return value;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (mediaKey.test(key.replace(/[_-]/g, '')) && imageValue(child)) { omitted++; continue; }
      // MCP often puts an entire JSON menu inside content[].text. Preserve its
      // string contract while removing only image values from the parsed data.
      if (key === 'text' && typeof child === 'string' && /^\s*[\[{]/.test(child)) {
        try { output[key] = JSON.stringify(walk(JSON.parse(child), depth + 1)); continue; } catch { /* free text is retained verbatim */ }
      }
      output[key] = walk(child, depth + 1);
    }
    return output;
  };
  const result = walk(input);
  return omitted && result && typeof result === 'object' && !Array.isArray(result) ?
    { ...result, result_compaction: { omitted_media_fields: omitted, all_non_media_fields_retained: true } } : input;
}
