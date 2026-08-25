'use strict';
// Security stub: pptxgenjs does not call image-size through this package in its
// shipped runtime. If a future code path does, never hand untrusted bytes to the
// vulnerable parser. Return a conservative fixed size instead of parsing files.
function sizeOf() {
  if (arguments.length === 0) {
    throw new TypeError('image-size requires a buffer/path argument');
  }
  return { width: 1, height: 1, type: 'png' };
}
sizeOf.default = sizeOf;
module.exports = sizeOf;
