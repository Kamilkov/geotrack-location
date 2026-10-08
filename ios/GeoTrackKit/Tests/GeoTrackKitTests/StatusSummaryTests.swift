import Foundation
import Testing
@testable import GeoTrackKit

@Suite struct StatusSummaryTests {
    typealias Stop = StatusSummary.Stop

    func summary(mode: Mode = .auto, setupComplete: Bool = true, workoutsSetupComplete: Bool = true, location: StatusSummary.Location = .always,
                 precise: Bool = true, backgroundRefresh: StatusSummary.BackgroundRefresh = .on, stops: [Stop] = [],
                 more: [StatusSummary.Problem] = [], waiting: Int = 0) -> StatusSummary {
        StatusSummary(mode: mode, setupComplete: setupComplete, workoutsSetupComplete: workoutsSetupComplete, location: location, precise: precise,
                      backgroundRefresh: backgroundRefresh, stops: stops, more: more, waiting: waiting)
    }

    func titles(_ summary: StatusSummary) -> [String] { summary.problems.map(\.title) }

    @Test func withNothingWrongItSaysWhatTheModeDoesAndWhatWaits() {
        #expect(summary() == StatusSummary(level: .fine, headline: "Recording, all sent", problems: []))
        #expect(summary(waiting: 3).headline == "Recording, 3 waiting")
        #expect(summary(mode: .manual).headline == "Recording, nothing waiting")
        #expect(summary(mode: .manual, waiting: 1).headline == "Recording, 1 waiting")
        #expect(summary(mode: .manual).level == .fine)
        #expect(summary(mode: .paused) == StatusSummary(level: .paused, headline: "Paused", problems: []))
        #expect(summary(mode: .paused, waiting: 2).headline == "Paused, 2 waiting")
    }

    @Test func withoutLocationAccessItDoesNotClaimToRecord() {
        for mode in [Mode.auto, .manual] {
            let denied = summary(mode: mode, location: .denied, precise: false, waiting: 2)
            #expect(denied.level == .notRecording)
            #expect(denied.headline == "Not recording")
            #expect(titles(denied) == ["Location access is denied"]) // Precise Location says nothing while there is no access
            #expect(titles(summary(mode: mode, location: .notAsked)) == ["Location access is not granted yet"])
            #expect(summary(mode: mode, location: .notAsked).level == .notRecording)
        }
        #expect(summary(mode: .paused, location: .denied).level == .paused) // paused is what the owner chose
        #expect(titles(summary(mode: .paused, location: .denied)) == ["Location access is denied"])
    }

    @Test func aProblemTurnsTheSignAndTheHeadlineKeepsSayingWhatWaits() {
        let whileUsing = summary(location: .whenInUse, waiting: 4)
        #expect(whileUsing.level == .attention) // it records: only the relaunch by iOS is at stake
        #expect(whileUsing.headline == "Recording, 4 waiting")
        #expect(summary(backgroundRefresh: .lowPower).headline == "Recording, all sent")
        #expect(summary(backgroundRefresh: .lowPower).level == .attention)
        #expect(summary(mode: .paused, backgroundRefresh: .off, waiting: 1) == StatusSummary(level: .paused, headline: "Paused, 1 waiting",
                                                                                         problems: summary(backgroundRefresh: .off).problems))
    }

    @Test func eachThingThatKeepsItFromWorkingIsAProblemOfItsOwnInAFixedOrder() {
        #expect(titles(summary(location: .whenInUse)) == ["Location access is \"While Using\""])
        #expect(titles(summary(precise: false)) == ["Precise Location is off"])
        for refresh in [StatusSummary.BackgroundRefresh.off, .restricted, .lowPower] {
            #expect(titles(summary(backgroundRefresh: refresh)) == ["Background App Refresh is off"])
        }
        #expect(Set([StatusSummary.BackgroundRefresh.off, .restricted, .lowPower].map { summary(backgroundRefresh: $0).problems[0].detail }).count == 3)
        #expect(titles(summary(setupComplete: false, workoutsSetupComplete: false)) == ["Setup is incomplete"])
        #expect(titles(summary(workoutsSetupComplete: false)) == ["Setup is incomplete for workouts"])
        let health = StatusSummary.Problem(title: "Health does not deliver in the background", detail: "x")
        let all = summary(setupComplete: false, location: .whenInUse, precise: false, backgroundRefresh: .off,
                          stops: [Stop(.photos, "the server rejects the token")], more: [health])
        #expect(titles(all) == ["Location access is \"While Using\"", "Precise Location is off", "Background App Refresh is off", "Setup is incomplete",
                                "Photos are stopped", "Health does not deliver in the background"])
        #expect(all.level == .attention)
    }

    @Test func stopsAreNamedByWhatTheyStopAndOneReasonIsSaidOnce() {
        let token = "the server rejects the token"
        #expect(summary(stops: [Stop(.positions, token), Stop(.workouts, token), Stop(.photos, token)]).problems
            == [.init(title: "Uploads are stopped", detail: "The server rejects the token. \"Send now\" tries again.")])
        #expect(titles(summary(stops: [Stop(.workouts, token), Stop(.photos, token)])) == ["Workouts and photos are stopped"])
        #expect(titles(summary(stops: [Stop(.positions, token)])) == ["Positions are stopped"])
        // A workout the server refuses does not stop the positions: the top must say so all the same.
        let workout = summary(stops: [Stop(.workouts, "the server refuses the request (413); a fault in the app")], waiting: 1)
        #expect(workout.level == .attention)
        #expect(workout.problems == [.init(title: "Workouts are stopped", detail: "The server refuses the request (413); a fault in the app. \"Send now\" tries again.")])
        #expect(titles(summary(stops: [Stop(.positions, token), Stop(.workouts, "another reason")])) == ["Positions are stopped", "Workouts are stopped"])
    }
}

@Suite struct StatusSummarySleepTests {
    @Test func asleepAtHomeIsSaidInTheHeadlineWithWhatWaits() {
        let asleep = StatusSummary(mode: .auto, setupComplete: true, workoutsSetupComplete: true, location: .always, precise: true,
                                   backgroundRefresh: .on, stops: [], more: [], waiting: 0, asleep: "since 23:14")
        #expect(asleep == StatusSummary(level: .fine, headline: "Asleep at Home since 23:14, all sent", problems: []))
        let waiting = StatusSummary(mode: .manual, setupComplete: true, workoutsSetupComplete: true, location: .always, precise: true,
                                    backgroundRefresh: .on, stops: [], more: [], waiting: 2, asleep: "since 23:14")
        #expect(waiting.headline == "Asleep at Home since 23:14, 2 waiting")
        let paused = StatusSummary(mode: .paused, setupComplete: true, workoutsSetupComplete: true, location: .always, precise: true,
                                   backgroundRefresh: .on, stops: [], more: [], waiting: 0, asleep: "since 23:14")
        #expect(paused.headline == "Paused", "Paused is the owner's word, not the phone's")
    }
}
