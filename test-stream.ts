const s = new ReadableStream({
  start(controller) {
    setTimeout(() => {
      controller.error(new Error("test error"));
    }, 100);
  }
});
// Stream is created but never read
setTimeout(() => {
  console.log("Process survived");
  process.exit(0);
}, 200);
