/**
 * Image loading, cropping, stretching and analysis for the agent's vision tools. Everything is
 * normalized into a float image (0..1, 1 or 3 channels).
 */
export { plateScaleArcsecPerPx, imagePlateScale, guessCamera, type FloatImage, type Crop } from './image/types.js';
export { crop, luminance, autoStretch, toJpeg } from './image/ops.js';
export { decode, isFlatJpeg } from './image/decode.js';
export { analyze, type Analysis } from './image/analyze.js';
export { loadImage, resolveLocalPath, devicePath } from './image/load.js';
