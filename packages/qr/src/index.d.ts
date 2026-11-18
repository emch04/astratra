/// <reference types="node" />
export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';
export interface QrOptions {
  /** Niveau de correction : L (7 %), M (15 %, par défaut), Q (25 %), H (30 %). */
  ecc?: QrErrorCorrection;
  minVersion?: number;
  maxVersion?: number;
  /** 0 à 7 ; le meilleur selon les pénalités de la norme par défaut. */
  mask?: number;
  /** Monter la correction tant que la même version le permet. */
  boostEcc?: boolean;
}
export interface QrModules {
  size: number;
  /** size × size, ligne par ligne : 1 pour un module sombre. */
  data: Uint8Array;
  get(row: number, column: number): boolean;
}
export interface Qr {
  version: number;
  ecc: QrErrorCorrection;
  mask: number;
  size: number;
  /** Même forme que qrcode.create(texte).modules (size, get) : @astratra/pdf la dessine directement. */
  modules: QrModules;
}
export function createQr(text: string, options?: QrOptions): Qr;
export interface QrSvgOptions extends QrOptions {
  /** Marge en modules (4 par défaut, ce que la norme demande). */
  margin?: number;
  dark?: string;
  light?: string | null;
  width?: number;
  /** Texte accessible (balise title). */
  title?: string;
}
export function qrToSvg(input: string | Qr, options?: QrSvgOptions): string;
export interface QrPngOptions extends QrOptions {
  margin?: number;
  /** Pixels par module (8 par défaut). */
  scale?: number;
  /** #rgb, #rrggbb ou #rrggbbaa. */
  dark?: string;
  light?: string;
}
/** Node seulement (node:zlib). */
export function qrToPng(input: string | Qr, options?: QrPngOptions): Buffer;
export function qrToDataUrl(input: string | Qr, options?: (QrSvgOptions & { type?: 'svg' }) | (QrPngOptions & { type: 'png' })): string;
export class QrError extends Error {}
