import Foundation
import Security
import Capacitor

@objc(SecureSessionPlugin)
public class SecureSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecureSessionPlugin"
    public let jsName = "SecureSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]

    private let accountKey = "commercial_insight_session_v1"

    private var serviceName: String {
        return Bundle.main.bundleIdentifier ?? "br.com.araujoempresarial.commercialinsight"
    }

    private func isValidToken(_ token: String) -> Bool {
        return token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }

    private func baseQuery() -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: accountKey
        ]
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let value = call.getString("value"), isValidToken(value),
              let data = value.data(using: .utf8) else {
            call.reject("Token de sessão inválido.")
            return
        }

        SecItemDelete(baseQuery() as CFDictionary)
        var query = baseQuery()
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly

        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("Não foi possível gravar a sessão no Keychain (código \(status)).")
        }
    }

    @objc func get(_ call: CAPPluginCall) {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let data = item as? Data,
              let token = String(data: data, encoding: .utf8),
              isValidToken(token) else {
            call.resolve(["value": NSNull()])
            return
        }
        call.resolve(["value": token])
    }

    @objc func clear(_ call: CAPPluginCall) {
        SecItemDelete(baseQuery() as CFDictionary)
        call.resolve()
    }
}
