'use strict';

/**
 * image-size-safe — fail-loud vendor stub.
 *
 * Advisory GHSA-w3rx-r6r6-pgpr and GHSA-5p2g-fcmc-qvqq cover the
 * current upstream 2.0.2. PptxGenJS does not invoke this module in its shipped
 * runtime; if a future path starts calling it, fail loudly instead of
 * accepting untrusted image bytes into the vulnerable parser.
 */
function sizeOf() {
  throw new Error(
    'image-size parsing is intentionally disabled by Auraxis vendor stub; ' +
      'use a patched parser or provide explicit image dimensions.',
  );
}

sizeOf.default = sizeOf;
module.exports = sizeOf;
