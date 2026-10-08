import CoreTransferable
import Foundation
import UniformTypeIdentifiers

/// A photo as the picker hands it over: the app's own copy of the file, under the picker's name for it.
struct PickedFile: Transferable {
    /// Where the copies lie until they are read. Emptied at every launch: a copy is an original, with its place.
    static let folder = FileManager.default.temporaryDirectory.appendingPathComponent("picked", isDirectory: true)

    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            // The picker's file is gone once this returns.
            let own = folder.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: own, withIntermediateDirectories: true)
            let copy = own.appendingPathComponent(received.file.lastPathComponent)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedFile(url: copy)
        }
    }

    /// Deletes the copy.
    func discard() { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
}
