export function controlTitle(value) {
  if (!value || typeof value.owner !== "string" || value.owner.length === 0 ||
      value.owner.length > 160 || /[\u0000-\u001f\u007f]/u.test(value.owner) ||
      (value.work !== null && (typeof value.work !== "string" || value.work.length > 240 ||
        /[\u0000-\u001f\u007f]/u.test(value.work)))) {
    throw new Error("NATIVE_PURPOSE_INVALID")
  }
  return `Desk | ${value.owner}${value.work === null ? "" : ` | ${value.work}`}`
}

function renderControl() {
  try {
    const label = JSON.parse(decodeURIComponent(location.hash.slice(1)))
    document.title = controlTitle(label)
    document.getElementById("owner").textContent = document.title
  } catch {
    document.title = "Desk | invalid ownership label"
    document.getElementById("owner").textContent = document.title
    console.error("NATIVE_CONTROL_LABEL_INVALID")
  }
}

if (typeof document !== "undefined") {
  renderControl()
  addEventListener("hashchange", renderControl)
}
