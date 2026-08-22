// Generate black/white transparent favicon.png and favicon.ico from
// assets/icon.svg. The SVG is already black in light mode and white in dark
// mode; this renders the light-mode black mark onto a transparent canvas for
// raster fallbacks.
//
// Usage:
//   swift scripts/make-favicon.swift
//
// The grey assets/icon.png and assets/icon.ico are intentionally separate:
// they are used by the dashboard rail and Windows shortcut generation.

import AppKit
import Foundation

func appendUInt16(_ data: inout Data, _ value: UInt16) {
  data.append(UInt8(value & 0xff))
  data.append(UInt8((value >> 8) & 0xff))
}

func appendUInt32(_ data: inout Data, _ value: UInt32) {
  data.append(UInt8(value & 0xff))
  data.append(UInt8((value >> 8) & 0xff))
  data.append(UInt8((value >> 16) & 0xff))
  data.append(UInt8((value >> 24) & 0xff))
}

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let svgURL = root.appendingPathComponent("assets/icon.svg")
let pngURL = root.appendingPathComponent("assets/favicon.png")
let icoURL = root.appendingPathComponent("assets/favicon.ico")
let tempDir = FileManager.default.temporaryDirectory.appendingPathComponent("modeldock-favicon-\(UUID().uuidString)")

do {
  try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
} catch {
  fputs("error: could not create temp directory: \(error)\n", stderr)
  exit(1)
}

let thumbnailProcess = Process()
thumbnailProcess.executableURL = URL(fileURLWithPath: "/usr/bin/qlmanage")
thumbnailProcess.arguments = ["-t", "-s", "1024", "-o", tempDir.path, svgURL.path]
do {
  try thumbnailProcess.run()
  thumbnailProcess.waitUntilExit()
} catch {
  fputs("error: qlmanage failed: \(error)\n", stderr)
  exit(1)
}
guard thumbnailProcess.terminationStatus == 0 else {
  fputs("error: qlmanage could not render assets/icon.svg\n", stderr)
  exit(1)
}

let thumbnailURL = tempDir.appendingPathComponent("icon.svg.png")
guard let qlImage = NSImage(contentsOf: thumbnailURL) else {
  fputs("error: could not load Quick Look thumbnail\n", stderr)
  exit(1)
}
qlImage.size = NSSize(width: 1024, height: 1024)

func renderTransparentPNG(image: NSImage, size: Int) -> Data? {
  let nsSize = NSSize(width: size, height: size)
  guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: size,
    pixelsHigh: size,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else { return nil }
  rep.size = nsSize

  NSGraphicsContext.saveGraphicsState()
  guard let context = NSGraphicsContext(bitmapImageRep: rep) else {
    NSGraphicsContext.restoreGraphicsState()
    return nil
  }
  NSGraphicsContext.current = context
  image.draw(
    in: NSRect(x: 0, y: 0, width: nsSize.width, height: nsSize.height),
    from: .zero,
    operation: .copy,
    fraction: 1
  )
  context.flushGraphics()
  NSGraphicsContext.restoreGraphicsState()

  // Quick Look renders the SVG on an opaque white canvas. The favicon should be
  // a transparent black/white mark, so remove near-white pixels after drawing.
  for y in 0..<size {
    for x in 0..<size {
      guard let color = rep.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
      let brightness = max(color.redComponent, max(color.greenComponent, color.blueComponent))
      guard brightness > 0.02 else { continue }
      let alpha = max(color.alphaComponent, 0)
      let newAlpha = brightness > 0.98
        ? 0
        : alpha * max(0, min(1, (1 - brightness) * 2))
      rep.setColor(
        NSColor(
          calibratedRed: color.redComponent,
          green: color.greenComponent,
          blue: color.blueComponent,
          alpha: newAlpha
        ),
        atX: x,
        y: y
      )
    }
  }

  return rep.representation(using: .png, properties: [:])
}

guard let largePNG = renderTransparentPNG(image: qlImage, size: 1024) else {
  fputs("error: could not render favicon.png\n", stderr)
  exit(1)
}
try largePNG.write(to: pngURL)
print("PNG written to \(pngURL.path) (\(largePNG.count) bytes)")

let icoSizes = [16, 24, 32, 48, 64, 128, 256]
var entries: [(size: Int, data: Data)] = []
for size in icoSizes {
  if let data = renderTransparentPNG(image: qlImage, size: size) {
    entries.append((size, data))
  }
}

guard !entries.isEmpty else {
  fputs("error: could not render favicon.ico sizes\n", stderr)
  exit(1)
}

var ico = Data()
appendUInt16(&ico, 0)
appendUInt16(&ico, 1)
appendUInt16(&ico, UInt16(entries.count))

var offset = 6 + entries.count * 16
var directory = Data()
for entry in entries {
  let width = entry.size >= 256 ? 0 : UInt8(entry.size)
  let height = entry.size >= 256 ? 0 : UInt8(entry.size)
  directory.append(width)
  directory.append(height)
  directory.append(0)
  directory.append(0)
  appendUInt16(&directory, 1)
  appendUInt16(&directory, 32)
  appendUInt32(&directory, UInt32(entry.data.count))
  appendUInt32(&directory, UInt32(offset))
  offset += entry.data.count
}

ico.append(directory)
for entry in entries {
  ico.append(entry.data)
}

try ico.write(to: icoURL)
print("ICO written to \(icoURL.path) (\(ico.count) bytes)")

try? FileManager.default.removeItem(at: tempDir)
