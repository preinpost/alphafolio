import Capacitor
import Foundation
import Security

/// 로그인 토큰을 iOS Keychain 에 저장하는 로컬 플러그인 (JS 이름: `Keychain`).
///
/// localStorage(WKWebView)나 @capacitor/preferences(UserDefaults)는 평문 plist 라
/// 기기 백업에 그대로 실린다. 금융 데이터에 붙는 토큰이라 Keychain 에 둔다.
/// 외부 플러그인을 들이지 않으려고 필요한 세 메서드만 직접 구현했다.
///
/// - 접근성: `AfterFirstUnlockThisDeviceOnly` — 재부팅 후 첫 잠금 해제 전에는 읽을 수 없고,
///   iCloud 키체인·다른 기기로 옮겨지지 않는다.
/// - 키는 JS 가 정한다 (`af_token`). 서비스 이름으로 앱 안에서만 구분한다.
@objc(KeychainPlugin)
public class KeychainPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KeychainPlugin"
    public let jsName = "Keychain"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]

    private let service = (Bundle.main.bundleIdentifier ?? "alphafolio") + ".auth"

    private func baseQuery(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("key 가 필요합니다") }
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            let value = (item as? Data).flatMap { String(data: $0, encoding: .utf8) }
            call.resolve(["value": value as Any])
        case errSecItemNotFound:
            call.resolve(["value": NSNull()])
        default:
            call.reject("Keychain 읽기 실패 (\(status))")
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            return call.reject("key·value 가 필요합니다")
        }
        let data = Data(value.utf8)
        // 있으면 갱신, 없으면 추가 — delete 후 add 는 그 사이에 실패하면 토큰이 사라진다
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(baseQuery(key) as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery(key)
            add.merge(update) { _, new in new }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        status == errSecSuccess ? call.resolve() : call.reject("Keychain 저장 실패 (\(status))")
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("key 가 필요합니다") }
        let status = SecItemDelete(baseQuery(key) as CFDictionary)
        status == errSecSuccess || status == errSecItemNotFound
            ? call.resolve()
            : call.reject("Keychain 삭제 실패 (\(status))")
    }
}

/// 앱 로컬 플러그인은 자동 등록되지 않는다 — 브리지가 뜰 때 직접 등록한다.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(KeychainPlugin())
    }
}
