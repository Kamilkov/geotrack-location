import GeoTrackKit
import PhotosUI
import SwiftUI

struct StatusView: View {
    @Bindable var model: AppModel
    @State private var picked: [PhotosPickerItem] = []
    /// The width the section symbols share, growing with the text size.
    @ScaledMetric(relativeTo: .headline) private var symbolWidth = 24.0

    var body: some View {
        NavigationStack {
            Form {
                summary
                problems
                positions
                workouts
                photos
            }
            .navigationTitle("GeoTrack")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    // Words, not a symbol: iOS shows a toolbar label as its icon alone, and an arrow does not say what it sends.
                    Button("Send now") { model.sendNow() }
                        .disabled(model.waiting == 0 && model.settings.workoutsConfig == nil && model.photosWaiting == 0)
                }
            }
            // On the form, not on the Photos section: a modifier on a section is applied to each of its rows.
            .onChange(of: picked) {
                model.addPhotos(picked)
                picked = []
            }
            .alert(model.photosHeld == 1 ? "1 photo carries no location. Send it anyway?" : "\(model.photosHeld) photos carry no location. Send them anyway?",
                   isPresented: Binding(get: { model.asksAboutLocation }, set: { _ in })) {
                Button("Send all") { model.answerNoLocation(send: true) }
                Button("Only those with location") { model.answerNoLocation(send: false) }
            }
            .onAppear { model.askForHealthAccess() }
        }
    }

    /// The one glance: whether it records, and how fresh the last position is. Shape and words carry the state,
    /// the colour only repeats it.
    private var summary: some View {
        Section {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                let (symbol, colour): (String, Color) = switch model.summary.level {
                case .fine: ("checkmark.circle.fill", .green)
                case .attention: ("exclamationmark.triangle.fill", .orange)
                case .notRecording: ("xmark.octagon.fill", .red)
                case .paused: ("pause.circle.fill", .secondary)
                }
                Image(systemName: symbol)
                    .font(.headline)
                    .foregroundStyle(colour)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.summary.headline)
                        .font(.headline)
                    Group {
                        if let kept = model.lastKept {
                            Text("Last position \(kept.time, style: .relative) ago") + Text(verbatim: kept.accuracy.map { ", within \($0) m" } ?? "")
                        } else {
                            Text("No position yet")
                        }
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
            Picker("Mode", selection: $model.mode) {
                Text("Auto").tag(Mode.auto)
                Text("Manual").tag(Mode.manual)
                Text("Paused").tag(Mode.paused)
            }
            .pickerStyle(.segmented)
        }
    }

    /// What keeps the app from working as it should; nothing at all while everything is fine.
    @ViewBuilder private var problems: some View {
        if !model.summary.problems.isEmpty {
            Section {
                ForEach(model.summary.problems) { problem in
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(problem.title)
                                .font(.subheadline.weight(.semibold))
                            Text(problem.detail)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }
            }
        }
    }

    private var positions: some View {
        Section {
            LabeledContent("Waiting", value: "\(model.waiting)")
            if model.rejected > 0 {
                LabeledContent("Rejected by the server", value: "\(model.rejected)")
                note("\"Send now\" sends them once more.")
            }
            LabeledContent("Last upload", value: model.uploadStatus)
        } header: {
            header("Positions", "location")
        }
    }

    private var workouts: some View {
        Section {
            let workouts = model.workouts
            LabeledContent("Sent", value: "\(workouts.sent)")
            LabeledContent("Waiting", value: "\(workouts.waiting)")
            if workouts.rejected > 0 {
                LabeledContent("Rejected by the server", value: "\(workouts.rejected)")
                if let reason = workouts.lastRejection { note("\(reason). \"Send now\" sends it again.") }
            }
            if workouts.held > 0 {
                LabeledContent("Held", value: "\(workouts.held)")
                note("Health shows less than was sent: check Settings → Apps → Health → Data Access & Devices → GeoTrack.")
            }
            LabeledContent("Last sent") {
                if let last = workouts.lastSent {
                    Text("\(AppModel.short(last.time)): \(last.heartRate) heart rate samples, \(last.route) route points")
                } else {
                    Text("none yet")
                }
            }
            // A stop is said on top, with everything it stops.
            if let problem = workouts.problem, workouts.stop == nil { warning(problem) }
            if workouts.found == 0 {
                note("No workouts found since \(model.settings.workoutsSince.formatted(date: .abbreviated, time: .omitted)): check Settings → Apps → Health → Data Access & Devices → GeoTrack.")
            }
        } header: {
            header("Workouts", "figure.walk")
        }
    }

    private var photos: some View {
        Section {
            // The picker runs outside the app: no access to the library is asked for, and the app
            // gets only the files that were picked, each in its own format.
            PhotosPicker(selection: $picked, matching: .images, preferredItemEncoding: .current) { Label("Add photos", systemImage: "plus") }
                .disabled(model.settings.serverConfig == nil || model.photosReading != nil)
            LabeledContent("Waiting", value: "\(model.photosWaiting)")
            if let reading = model.photosReading { Text(reading) }
            if let summary = model.photos.summary, let time = model.photos.time {
                VStack(alignment: .leading, spacing: 4) {
                    LabeledContent("Last result", value: AppModel.short(time))
                    Text(summary)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } else {
                LabeledContent("Last result", value: "none yet")
            }
            ForEach(model.photos.lines) { line in note(line.text) }
            if let problem = model.photosProblem, model.photosStop == nil { warning(problem) }
        } header: {
            header("Photos", "photo")
        }
    }

    /// A section's name behind its symbol. The symbols differ in width; the frame keeps the names in one line.
    private func header(_ title: String, _ symbol: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
                .frame(width: symbolWidth)
                .accessibilityHidden(true)
            Text(title)
        }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
    }

    private func warning(_ text: String) -> some View {
        Label {
            Text(text)
                .font(.footnote)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
        }
    }
}
