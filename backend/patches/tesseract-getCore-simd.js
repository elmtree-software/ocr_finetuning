/**
 * Patched getCore for Node.js Tesseract.js
 *
 * Why:
 * - On Node.js v24, `wasm-feature-detect` reports `relaxedSimd()` support.
 * - `tesseract.js` then picks the "relaxedSIMD" core, which currently crashes with:
 *   `Aborted(missing function: _ZN9tesseract13DotProductSSEEPKfS1_i)`
 *
 * Fix:
 * - Prefer the stable SIMD core (`tesseract-core-simd(-lstm)`) and ignore relaxedSIMD.
 * - Match the current adapter signature: `(lstmOnly, corePath, res)` (first arg is boolean).
 *
 * To apply:
 * - Copy this file to `node_modules/tesseract.js/src/worker-script/node/getCore.js`
 *   or run `node scripts/patch_tesseract_node_getcore.mjs` from the repo root.
 */

'use strict';

const { simd } = require('wasm-feature-detect');

let TesseractCore = null;

module.exports = async (lstmOnly, _corePath, res) => {
    if (TesseractCore === null) {
        const statusText = 'loading tesseract core';

        const simdSupport = await simd();
        res.progress({ status: statusText, progress: 0 });

        if (simdSupport) {
            TesseractCore = lstmOnly
                ? require('tesseract.js-core/tesseract-core-simd-lstm')
                : require('tesseract.js-core/tesseract-core-simd');
        } else {
            TesseractCore = lstmOnly
                ? require('tesseract.js-core/tesseract-core-lstm')
                : require('tesseract.js-core/tesseract-core');
        }
        res.progress({ status: statusText, progress: 1 });
    }
    return TesseractCore;
};
