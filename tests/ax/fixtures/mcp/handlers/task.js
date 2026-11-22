export function create(input) {
  if (!input.slug) return { error: "slug_invalid" }
  const card = { code: "never-raised-here", means: "x", fix: "y" }
  return card
}
