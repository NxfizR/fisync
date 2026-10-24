// Sends the nearby Bluetooth beacon on a Mac. Apple only allows a service ID in advertisements,
// so the 16-byte beacon is sent as a 128-bit service ID. Needs Xcode command line tools (xcode-select --install).
// Untested on hardware at the time of writing: please report what happens.
import Foundation
import CoreBluetooth

let beaconPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""

func bytes(fromHex hex: String) -> Data? {
    let chars = Array(hex)
    guard chars.count % 2 == 0 else { return nil }
    var out = Data()
    var i = 0
    while i < chars.count {
        guard let b = UInt8(String(chars[i...i + 1]), radix: 16) else { return nil }
        out.append(b)
        i += 2
    }
    return out
}

final class Beacon: NSObject, CBPeripheralManagerDelegate {
    var manager: CBPeripheralManager!
    var lastHex = ""

    override init() {
        super.init()
        manager = CBPeripheralManager(delegate: self, queue: nil)
    }

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        if peripheral.state == .poweredOn { refresh() }
    }

    func refresh() {
        guard manager.state == .poweredOn,
              let data = try? Data(contentsOf: URL(fileURLWithPath: beaconPath)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let hex = json["hex"] as? String, hex != lastHex,
              let payload = bytes(fromHex: hex) else { return }
        lastHex = hex
        manager.stopAdvertising()
        manager.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [CBUUID(data: payload)]])
        print("beacon on")
    }
}

let beacon = Beacon()
Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { _ in beacon.refresh() }
RunLoop.main.run()
