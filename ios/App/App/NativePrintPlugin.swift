import UIKit
import Capacitor

@objc(NativePrintPlugin)
public class NativePrintPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativePrintPlugin"
    public let jsName = "NativePrint"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "printHtml", returnType: CAPPluginReturnPromise)
    ]

    @objc func printHtml(_ call: CAPPluginCall) {
        guard let html = call.getString("html"), !html.isEmpty else {
            call.reject("Conteúdo de impressão ausente.")
            return
        }
        let rawJobName = call.getString("jobName") ?? "Comercial Insight · Relatório Comercial"
        let jobName = rawJobName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "Comercial Insight"
            : rawJobName.trimmingCharacters(in: .whitespacesAndNewlines)

        DispatchQueue.main.async {
            let printInfo = UIPrintInfo(dictionary: nil)
            printInfo.outputType = .general
            printInfo.jobName = jobName

            let formatter = UIMarkupTextPrintFormatter(markupText: html)
            let controller = UIPrintInteractionController.shared
            controller.printInfo = printInfo
            controller.printFormatter = formatter

            controller.present(animated: true) { _, completed, error in
                if let error = error {
                    call.reject("Não foi possível imprimir ou gerar o PDF: \(error.localizedDescription)")
                    return
                }
                call.resolve(["printed": completed])
            }
        }
    }
}
