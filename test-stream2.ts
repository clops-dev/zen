const s = new ReadableStream({
  start(controller) {
    setTimeout(() => {
      controller.error(new Error("test stream error"));
    }, 100);
  }
});
const resp = new Response(s);
// resp is discarded!

setTimeout(() => {
  console.log("Process survived");
  process.exit(0);
}, 200);
