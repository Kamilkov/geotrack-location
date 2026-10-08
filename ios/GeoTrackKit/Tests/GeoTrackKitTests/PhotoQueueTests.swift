import Foundation
import Testing
@testable import GeoTrackKit

@Suite struct PhotoQueueTests {
    @Test func whatIsAddedIsReadBackOldestFirst() throws {
        let queue = try PhotoQueue(directory: scratch())
        let later = try queue.append(photo("IMG_0002.HEIC"), at: origin.addingTimeInterval(1))
        let earlier = try queue.append(photo("IMG_0001.HEIC"), at: origin)
        #expect(queue.names() == [earlier, later])
        #expect(queue.photo(earlier) == photo("IMG_0001.HEIC"))
        #expect(queue.count() == 2)
    }

    @Test func twoPhotosAddedInTheSameMillisecondAreBothKept() throws {
        let queue = try PhotoQueue(directory: scratch())
        try queue.append(photo("IMG_0001.HEIC"), at: origin)
        try queue.append(photo("IMG_0002.HEIC"), at: origin)
        #expect(queue.count() == 2)
    }

    @Test func aRemovedPhotoIsGone() throws {
        let queue = try PhotoQueue(directory: scratch())
        let name = try queue.append(photo())
        try queue.remove(name)
        #expect(queue.names().isEmpty)
    }

    @Test func aFileThatIsNoPhotoIsRemovedAndDoesNotBlock() throws {
        let queue = try PhotoQueue(directory: scratch())
        try Data("not a photo".utf8).write(to: queue.directory.appendingPathComponent("0000000000000-x.json"))
        let name = try queue.append(photo())
        #expect(queue.photo("0000000000000-x.json") == nil)
        #expect(queue.names() == [name])
    }

    @Test func aFileThatCannotBeReadStays() throws {
        let queue = try PhotoQueue(directory: scratch())
        let name = try queue.append(photo())
        let file = queue.directory.appendingPathComponent(name)
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: file.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path) }
        #expect(queue.photo(name) == nil)
        #expect(queue.names() == [name])
    }

    @Test func theFolderIsKeptOutOfBackupsAndOnlyJSONFilesCount() throws {
        let queue = try PhotoQueue(directory: scratch())
        #expect(try queue.directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
        try Data().write(to: queue.directory.appendingPathComponent("last-result"))
        #expect(queue.count() == 0)
    }
}
