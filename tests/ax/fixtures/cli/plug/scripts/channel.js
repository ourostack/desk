// A hand-written entry point: no kit, its first argument compared by hand.
const [command] = process.argv.slice(2)
if (command === "send") console.log("send")
else if (command !== "read" && command !== "--help") process.exit(2)
