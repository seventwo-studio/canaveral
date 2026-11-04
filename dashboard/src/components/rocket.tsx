import { useRef, useState } from "react";
import type { SyntheticEvent } from "react";

// Eight-by-eight ordered dithering: stable pixels, no animation or GPU loop.
const bayer = [
  [0, 48, 12, 60, 3, 51, 15, 63],
  [32, 16, 44, 28, 35, 19, 47, 31],
  [8, 56, 4, 52, 11, 59, 7, 55],
  [40, 24, 36, 20, 43, 27, 39, 23],
  [2, 50, 14, 62, 1, 49, 13, 61],
  [34, 18, 46, 30, 33, 17, 45, 29],
  [10, 58, 6, 54, 9, 57, 5, 53],
  [42, 26, 38, 22, 41, 25, 37, 21],
] as const;
const charcoal = [
  [12, 12, 12],
  [64, 64, 64],
  [140, 140, 140],
  [240, 240, 240],
] as const;
const flame = [
  [43, 34, 23],
  [136, 76, 42],
  [255, 122, 26],
  [255, 209, 174],
] as const;

export function RocketArt() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  function renderPhoto(event: SyntheticEvent<HTMLImageElement>) {
    const target = canvas.current;
    if (!target) return;
    const context = target.getContext("2d", { willReadFrequently: true });
    if (!context) return; // The photograph remains visible if canvas is unavailable.
    const image = event.currentTarget;
    context.drawImage(image, 0, 0, target.width, target.height);
    const frame = context.getImageData(0, 0, target.width, target.height);
    for (let y = 0; y < target.height; y++) {
      for (let x = 0; x < target.width; x++) {
        const i = (y * target.width + x) * 4;
        const r = frame.data[i]!,
          g = frame.data[i + 1]!,
          b = frame.data[i + 2]!;
        const luminance = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
        // Deep sky, bright hardware and billowing smoke; retain the warm boosters.
        const contrast = Math.max(0, Math.min(1, (luminance - 0.29) * 1.65));
        const threshold = (bayer[y % 8]![x % 8]! + 0.5) / 64 - 0.5;
        const level = Math.max(
          0,
          Math.min(3, Math.floor(contrast * 3 + threshold + 0.5)),
        );
        const inPlume =
          x / target.width > 0.45 &&
          x / target.width < 0.59 &&
          y / target.height > 0.47 &&
          y / target.height < 0.68;
        const warm = r > g * 1.12 && g > b * 1.08;
        const color = (inPlume || warm ? flame : charcoal)[level]!;
        frame.data[i] = color[0];
        frame.data[i + 1] = color[1];
        frame.data[i + 2] = color[2];
      }
    }
    context.putImageData(frame, 0, 0);
    setReady(true);
  }

  return (
    <div className="rocket-art" data-rendered={ready} aria-hidden="true">
      <img src="/launch.jpg" alt="" onLoad={renderPhoto} decoding="async" />
      <canvas ref={canvas} width={384} height={576} />
    </div>
  );
}
