// Main window layout (logical px). The window is 280×266 (tauri.conf.json).
export const WINDOW_W = 280;
export const WINDOW_H = 266;
export const ORB_CX = 140;
export const ORB_CY = 126;
export const ORB_R = 55;
export const RING_OUTER = 65; // ring r=104 + half stroke in the Face's 200 viewBox, scaled to the orb
export const CHIP_ARC_R = 108; // chip centres; keeps the widest chip row clear of the ring
export const TIME_TOP = 197; // just below the ring

// Settings button: bottom left of the ring, overlapping it minimally
export const SETTINGS_BTN_SIZE = 22;
export const SETTINGS_BTN_DIST = 72; // from the orb centre
export const SETTINGS_BTN_ANGLE = 225; // degrees clockwise from 12 o'clock

// Extent of the visible content (widest chip row, time pill), used for the default placement
export const CONTENT_RIGHT = 266;
export const CONTENT_BOTTOM = 262;
export const DEFAULT_MARGIN = 24;
