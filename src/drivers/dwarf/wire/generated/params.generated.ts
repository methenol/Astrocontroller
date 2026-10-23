/**
 * Device camera parameter tables, shipped verbatim in the APK at assets/params_range.json.
 * These map human-readable settings to the raw indices the firmware expects.
 */

export const PARAMS_RANGE = {
  expValues: [
    {
      name: '1/10000',
      value: 0,
    },
    {
      name: '1/8000',
      value: 3,
    },
    {
      name: '1/6400',
      value: 6,
    },
    {
      name: '1/5000',
      value: 9,
    },
    {
      name: '1/4000',
      value: 12,
    },
    {
      name: '1/3200',
      value: 15,
    },
    {
      name: '1/2500',
      value: 18,
    },
    {
      name: '1/2000',
      value: 21,
    },
    {
      name: '1/1600',
      value: 24,
    },
    {
      name: '1/1250',
      value: 27,
    },
    {
      name: '1/1000',
      value: 30,
    },
    {
      name: '1/800',
      value: 33,
    },
    {
      name: '1/640',
      value: 36,
    },
    {
      name: '1/500',
      value: 39,
    },
    {
      name: '1/400',
      value: 42,
    },
    {
      name: '1/320',
      value: 45,
    },
    {
      name: '1/250',
      value: 48,
    },
    {
      name: '1/200',
      value: 51,
    },
    {
      name: '1/160',
      value: 54,
    },
    {
      name: '1/125',
      value: 57,
    },
    {
      name: '1/100',
      value: 60,
    },
    {
      name: '1/80',
      value: 63,
    },
    {
      name: '1/60',
      value: 66,
    },
    {
      name: '1/50',
      value: 69,
    },
    {
      name: '1/40',
      value: 72,
    },
    {
      name: '1/30',
      value: 75,
    },
    {
      name: '1/25',
      value: 78,
    },
    {
      name: '1/20',
      value: 81,
    },
    {
      name: '1/15',
      value: 84,
    },
    {
      name: '1/13',
      value: 87,
    },
    {
      name: '1/10',
      value: 90,
    },
    {
      name: '1/8',
      value: 93,
    },
    {
      name: '1/6',
      value: 96,
    },
    {
      name: '1/5',
      value: 99,
    },
    {
      name: '1/4',
      value: 102,
    },
    {
      name: '1/3',
      value: 105,
    },
    {
      name: '0.4',
      value: 108,
    },
    {
      name: '0.5',
      value: 111,
    },
    {
      name: '0.6',
      value: 114,
    },
    {
      name: '0.8',
      value: 117,
    },
    {
      name: '1',
      value: 120,
    },
    {
      name: '1.3',
      value: 123,
    },
    {
      name: '1.6',
      value: 126,
    },
    {
      name: '2',
      value: 129,
    },
    {
      name: '2.5',
      value: 132,
    },
    {
      name: '3.2',
      value: 135,
    },
    {
      name: '4',
      value: 138,
    },
    {
      name: '5',
      value: 141,
    },
    {
      name: '6',
      value: 144,
    },
    {
      name: '8',
      value: 147,
    },
    {
      name: '10',
      value: 150,
    },
    {
      name: '13',
      value: 153,
    },
    {
      name: '15',
      value: 156,
    },
    {
      name: '30',
      value: 159,
    },
    {
      name: '45',
      value: 160,
    },
    {
      name: '60',
      value: 162,
    },
    {
      name: '90',
      value: 163,
    },
    {
      name: '120',
      value: 165,
    },
    {
      name: '180',
      value: 168,
    },
    {
      name: '240',
      value: 171,
    },
    {
      name: '300',
      value: 174,
    },
  ],
  expRange: [
    {
      deviceId: 1,
      cameraId: 0,
      defaultValue: 156,
      values: [120, 123, 126, 129, 132, 135, 138, 141, 144, 147, 150, 153, 156],
      darkFrameValues: [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84, 87, 90, 93, 96, 99, 102, 105, 108, 111, 114, 117, 120, 123, 126, 129, 132, 135, 138, 141, 144, 147, 150, 153, 156],
    },
    {
      deviceId: 1,
      cameraId: 1,
      defaultValue: 120,
      values: [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84, 87, 90, 93, 96, 99, 102, 105, 108, 111, 114, 117, 120],
    },
    {
      deviceId: 2,
      cameraId: 0,
      defaultValue: 156,
      values: [120, 123, 126, 129, 132, 135, 138, 141, 144, 147, 150, 153, 156, 159, 160, 162, 163, 165],
      darkFrameValues: [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84, 87, 90, 93, 96, 99, 102, 105, 108, 111, 114, 117, 120, 123, 126, 129, 132, 135, 138, 141, 144, 147, 150, 153, 156, 159, 160, 162, 163, 165],
    },
    {
      deviceId: 2,
      cameraId: 1,
      defaultValue: 156,
      values: [120, 123, 126, 129, 132, 135, 138, 141, 144, 147, 150, 153, 156, 159, 160, 162, 163],
      darkFrameValues: [120, 123, 126, 129, 132, 135, 138, 141, 144, 147, 150, 153, 156, 159, 160, 162, 163],
    },
    {
      deviceId: 4,
      cameraId: 0,
      defaultValue: 156,
      values: [120, 123, 126, 129, 132, 135, 138, 141, 144, 147, 150, 153, 156, 159, 160, 162, 163, 165, 168],
      darkFrameValues: [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84, 87, 90, 93, 96, 99, 102, 105, 108, 111, 114, 117, 120, 123, 126, 129, 132, 135, 138, 141, 144, 147, 150, 153, 156, 159, 160, 162, 163, 165, 168],
    },
    {
      deviceId: 4,
      cameraId: 1,
      defaultValue: 156,
      values: [120, 123, 126, 129, 132, 135, 138, 141, 144, 147, 150, 153, 156, 159],
      darkFrameValues: [120, 123, 126, 129, 132, 135, 138, 141, 144, 147, 150, 153, 156, 159],
    },
    {
      deviceId: 6,
      cameraId: 0,
      defaultValue: 156,
      values: [120, 123, 126, 129, 132, 135, 138, 141, 144, 147, 150, 153, 156, 159, 160, 162, 163, 165, 168, 171, 174],
      darkFrameValues: [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84, 87, 90, 93, 96, 99, 102, 105, 108, 111, 114, 117, 120, 123, 126, 129, 132, 135, 138, 141, 144, 147, 150, 153, 156, 159, 160, 162, 163, 165, 168, 171, 174],
    },
    {
      deviceId: 6,
      cameraId: 1,
      defaultValue: 156,
      values: [120, 123, 126, 129, 132, 135, 138, 141, 144, 147, 150, 153, 156, 159, 160, 162, 163],
      darkFrameValues: [120, 123, 126, 129, 132, 135, 138, 141, 144, 147, 150, 153, 156, 159, 160, 162, 163],
    },
  ],
  gainRange: [
    {
      deviceId: 1,
      cameraId: 0,
      defaultValue: 60,
      values: [40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240],
      darkFrameValues: [40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240],
    },
    {
      deviceId: 1,
      cameraId: 1,
      defaultValue: 60,
      values: [60, 70, 80, 90, 100, 110, 120],
      darkFrameValues: [60, 70, 80, 90, 100, 110, 120],
    },
    {
      deviceId: 2,
      cameraId: 0,
      defaultValue: 60,
      values: [40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240],
      darkFrameValues: [0, 2, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240],
    },
    {
      deviceId: 2,
      cameraId: 1,
      defaultValue: 60,
      values: [40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240],
      darkFrameValues: [0, 2, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240],
    },
    {
      deviceId: 4,
      cameraId: 0,
      defaultValue: 60,
      values: [40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240],
      darkFrameValues: [0, 2, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240],
    },
    {
      deviceId: 4,
      cameraId: 1,
      defaultValue: 60,
      values: [40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240],
      darkFrameValues: [40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240],
    },
    {
      deviceId: 6,
      cameraId: 0,
      defaultValue: 60,
      values: [0, 2, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240],
      darkFrameValues: [0, 2, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240],
    },
    {
      deviceId: 6,
      cameraId: 1,
      defaultValue: 60,
      values: [0, 2, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240],
      darkFrameValues: [0, 2, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240],
    },
  ],
  filterRange: [
    {
      deviceId: 1,
      cameraId: 0,
      defaultValue: 1,
      values: [0, 1],
    },
    {
      deviceId: 2,
      cameraId: 0,
      defaultValue: 1,
      values: [0, 1, 2],
    },
    {
      deviceId: 4,
      cameraId: 0,
      defaultValue: 1,
      values: [1, 2],
    },
    {
      deviceId: 6,
      cameraId: 0,
      defaultValue: 1,
      values: [1, 2],
    },
  ],
  darkFrameCount: [
    {
      deviceId: 1,
      cameraId: 0,
      min: 1,
      max: 999,
      step: 1,
      defaultValue: 10,
    },
    {
      deviceId: 2,
      cameraId: 0,
      min: 1,
      max: 999,
      step: 1,
      defaultValue: 10,
    },
    {
      deviceId: 2,
      cameraId: 1,
      min: 1,
      max: 999,
      step: 1,
      defaultValue: 10,
    },
    {
      deviceId: 4,
      cameraId: 0,
      min: 1,
      max: 999,
      step: 1,
      defaultValue: 10,
    },
    {
      deviceId: 4,
      cameraId: 1,
      min: 1,
      max: 999,
      step: 1,
      defaultValue: 10,
    },
    {
      deviceId: 6,
      cameraId: 0,
      min: 1,
      max: 999,
      step: 1,
      defaultValue: 10,
    },
    {
      deviceId: 6,
      cameraId: 1,
      min: 1,
      max: 999,
      step: 1,
      defaultValue: 10,
    },
  ],
  resolutionRange: [
    {
      deviceId: 1,
      cameraId: 0,
      defaultValue: 0,
      values: [0],
    },
    {
      deviceId: 2,
      cameraId: 0,
      defaultValue: 0,
      values: [0, 1],
    },
    {
      deviceId: 2,
      cameraId: 1,
      defaultValue: 1,
      values: [1],
    },
    {
      deviceId: 4,
      cameraId: 0,
      defaultValue: 1,
      values: [1],
    },
    {
      deviceId: 4,
      cameraId: 1,
      defaultValue: 1,
      values: [1],
    },
    {
      deviceId: 6,
      cameraId: 0,
      defaultValue: 3,
      values: [3, 4],
    },
    {
      deviceId: 6,
      cameraId: 1,
      defaultValue: 3,
      values: [3, 4],
    },
  ],
} as const;

export type ExposureName = (typeof PARAMS_RANGE.expValues)[number]['name'];

/** The raw shutter index the firmware expects for a label like "1/1000", or null if unknown. */
export function exposureIndex(name: string): number | null {
  return PARAMS_RANGE.expValues.find((e) => e.name === name)?.value ?? null;
}
