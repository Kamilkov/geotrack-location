import GeoTrackKit
import SwiftUI

struct SetupView: View {
    let model: AppModel
    @State private var draft = Settings()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    field("Address") {
                        TextField("https://…", text: $draft.server)
                            .keyboardType(.URL)
                    }
                    field("Token") {
                        SecureField("Upload token", text: $draft.token)
                            .textContentType(.oneTimeCode) // keeps iOS from offering to save it as a password in iCloud
                    }
                    field("Device name") { TextField("iphone", text: $draft.device) }
                } header: {
                    Text("Server")
                } footer: {
                    if draft.serverConfig == nil { Text("Needs an https address, a token and a device name of a-z, 0-9 and -.") }
                }
                Section {
                    field("Device name") { TextField("iphone", text: $draft.workoutsDevice) }
                    // The picker keeps the old time of day; a chosen day counts from its local midnight.
                    DatePicker("Workouts since", selection: Binding(get: { draft.workoutsSince }, set: { draft.workoutsSince = Calendar.current.startOfDay(for: $0) }),
                               displayedComponents: .date)
                } header: {
                    Text("Workouts")
                } footer: {
                    if draft.serverConfig != nil, draft.workoutsConfig == nil { Text("The device name needs a-z, 0-9 and -.") }
                }
                #if targetEnvironment(simulator)
                Section {
                    Button("Add a synthetic workout (Simulator only)") { model.addSyntheticWorkout() }
                }
                #endif
            }
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Setup")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { model.saveSettings(draft) }
                        .disabled(draft == model.settings && model.settingsProblem == nil) // a save that failed can be tried again
                }
            }
            .onAppear { draft = model.settings }
        }
    }

    /// A row that keeps its name once it is filled in: the name on the left, the value on the right.
    private func field(_ name: String, @ViewBuilder _ input: () -> some View) -> some View {
        LabeledContent(name) {
            input()
                .multilineTextAlignment(.trailing)
        }
    }
}
