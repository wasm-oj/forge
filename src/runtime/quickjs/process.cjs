const ticks = [];
let scheduled = false;
function drain() {
  try {
    while (ticks.length) {
      const [callback, args] = ticks.shift();
      callback(...args);
    }
  } finally {
    scheduled = false;
  }
}
const process = {
  env: {},
  nextTick(callback, ...args) {
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    ticks.push([callback, args]);
    if (!scheduled) {
      scheduled = true;
      Promise.resolve().then(drain);
    }
  },
};
module.exports = process;
