// Local STT for macOS using Apple's SpeechAnalyzer / SpeechTranscriber APIs.
//
// This is a tiny CLI helper so ModelDock's Node.js gateway can use Apple's
// on-device speech-to-text model without bundling Whisper/MLX. It reads a file
// and prints one JSON object to stdout.
//
// Usage:
//   modeldock-stt-helper /path/to/audio.m4a en-US
//   => {"text":"...","language":"en-US","confidence":0}
//
// Build:
//   swiftc -O -o dist/modeldock-stt-helper scripts/stt-mac-helper.swift \
//     -framework Speech -framework AVFoundation

import AVFoundation
import Foundation
import Speech

@main
struct ModelDockSTTMac {
  static func main() async {
    do {
      try await run()
    } catch {
      FileHandle.standardError.write(Data("modeldock-stt-helper: \(error)\n".utf8))
      exit(1)
    }
  }

  static func run() async throws {
    let args = CommandLine.arguments
    guard args.count >= 2 else {
      throw HelperError("usage: modeldock-stt-helper <audio-file> [locale]")
    }

    let fileURL = URL(fileURLWithPath: args[1])
    guard FileManager.default.fileExists(atPath: fileURL.path) else {
      throw HelperError("audio file not found: \(fileURL.path)")
    }

    let requested = args.count > 2 ? Locale(identifier: args[2]) : Locale.current
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
      throw HelperError("unsupported locale: \(requested.identifier)")
    }

    let transcriber = SpeechTranscriber(
      locale: locale,
      transcriptionOptions: [],
      reportingOptions: [],
      attributeOptions: []
    )

    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      try await request.downloadAndInstall()
    }

    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let collector = FinalTextCollector()

    let resultsTask = Task {
      do {
        for try await result in transcriber.results where result.isFinal {
          collector.append(String(result.text.characters))
        }
      } catch {
        // analyzeSequence will usually surface the underlying problem; keep the
        // result stream from crashing the helper before it can finalize.
      }
    }

    guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
      throw HelperError("could not determine an analyzer audio format")
    }
    let (inputSequence, inputContinuation) = AsyncStream<AnalyzerInput>.makeStream()
    // Start consuming before feeding. Creating the analysis task after the
    // file loop would make AsyncStream retain every decoded block for a long
    // recording, despite the per-block allocation below being bounded.
    let analysisTask = Task {
      try await analyzer.analyzeSequence(inputSequence)
    }
    let audioFile = try AVAudioFile(forReading: fileURL)
    guard let audioConverter = AVAudioConverter(from: audioFile.processingFormat, to: analyzerFormat) else {
      throw HelperError("could not create audio converter")
    }

    // Each decoded block is bounded, and the analyzer consumes the stream as
    // it is fed, so a long recording is not materialized as one PCM buffer.
    let chunkFrames: AVAudioFrameCount = 44_100 * 15
    while audioFile.framePosition < audioFile.length {
      let remaining = AVAudioFrameCount(audioFile.length - audioFile.framePosition)
      let frames = min(remaining, chunkFrames)
      guard let buffer = AVAudioPCMBuffer(
        pcmFormat: audioFile.processingFormat,
        frameCapacity: frames
      ) else {
        throw HelperError("could not allocate audio buffer")
      }
      try audioFile.read(into: buffer)
      if buffer.frameLength == 0 { break }
      for input in try convertBuffer(buffer, converter: audioConverter, to: analyzerFormat) {
        inputContinuation.yield(input)
      }
    }

    for input in try flushConverter(audioConverter, to: analyzerFormat) {
      inputContinuation.yield(input)
    }
    inputContinuation.finish()

    let lastSampleTime = try await analysisTask.value

    if let lastSampleTime {
      try await analyzer.finalizeAndFinish(through: lastSampleTime)
    } else {
      await analyzer.cancelAndFinishNow()
    }

    await resultsTask.value

    let output: [String: Any] = [
      "text": collector.text,
      "language": locale.identifier,
      "confidence": 0.0,
    ]
    let data = try JSONSerialization.data(withJSONObject: output)
    print(String(data: data, encoding: .utf8) ?? "{}")
  }
}

private struct HelperError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

private final class FinalTextCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var value = ""

  func append(_ piece: String) {
    lock.lock()
    defer { lock.unlock() }
    if !piece.isEmpty {
      value += piece
    }
  }

  var text: String {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

private func convertBuffer(
  _ input: AVAudioPCMBuffer,
  converter: AVAudioConverter,
  to outputFormat: AVAudioFormat
) throws -> [AnalyzerInput] {
  guard input.frameLength > 0 else { return [] }
  let estimatedFrames = max(
    4096,
    AVAudioFrameCount(Double(input.frameLength) * outputFormat.sampleRate / input.format.sampleRate) + 64
  )
  guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: estimatedFrames) else {
    throw HelperError("could not allocate converted audio buffer")
  }
  var conversionError: NSError?
  let status = converter.convert(to: output, error: &conversionError) { _, outStatus in
    outStatus.pointee = .haveData
    return input
  }
  guard status == .haveData else {
    if let conversionError {
      throw HelperError("audio conversion failed: \(conversionError.localizedDescription)")
    }
    return []
  }
  return [AnalyzerInput(buffer: output, bufferStartTime: nil)]
}

private func flushConverter(
  _ converter: AVAudioConverter,
  to outputFormat: AVAudioFormat
) throws -> [AnalyzerInput] {
  guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: 8192) else {
    throw HelperError("could not allocate flush audio buffer")
  }
  var conversionError: NSError?
  let status = converter.convert(to: output, error: &conversionError) { _, outStatus in
    outStatus.pointee = .endOfStream
    return nil
  }
  guard status == .haveData else { return [] }
  return [AnalyzerInput(buffer: output, bufferStartTime: nil)]
}
