export function markerTargetUrl(marker) {
  const html = `<!doctype html><meta charset="utf-8"><title>Desk target marker</title><meta name="desk-target-marker" content="${marker}">`
  return `data:text/html,${encodeURIComponent(html)}`
}
