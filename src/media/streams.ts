/**
 * Live imagery:
 *  - tele/wide: RTSP (H.265 1080p30) on :554 → ffmpeg → MJPEG frames, on demand.
 *  - stack:     the telescope's own multipart JPEG stream on :8092/mainstream, which carries the
 *               live-stacking result while stacking runs.
 * Each source keeps its latest JPEG for snapshots and fans frames out to browser clients.
 */
export { Source, type Frame, type Sink } from './stream/source.js';
export { CameraSource } from './stream/camera.js';
export { StackSource } from './stream/stack.js';
export { StreamHub } from './stream/hub.js';
export { JpegSplitter } from './stream/jpeg.js';
