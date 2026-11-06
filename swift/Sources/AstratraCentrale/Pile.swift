import Foundation

/// La pile d'appels lue dans `Thread.callStackSymbols` (ou `NSException.callStackSymbols`).
/// Chaque ligne ressemble à « 3   MonApp   0x0000000100abc123 $s6MonApp4vueV4corpsyyF + 52 ».
enum Pile {
    /// Le module de l'application : ses cadres sont marqués `app`.
    static var moduleApp: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleExecutable") as? String ?? ProcessInfo.processInfo.processName
    }

    /// `adresses` (les adresses de retour, dans le même ordre que `symboles`) ajoutent à chaque cadre l'UUID de son binaire ;
    /// un cadre sans nom de fonction (binaire publié, symboles retirés : « MonApp + 5552808 ») prend son décalage, « +5552808 »,
    /// que le serveur traduit avec la table de symboles du build.
    static func lire(_ symboles: [String], adresses: [NSNumber]? = nil, moduleApp: String = Pile.moduleApp, ignorerModule: String? = "AstratraCentrale",
                     position: (UInt) -> Binaires.Position? = Binaires.position) -> [Cadre] {
        var cadres: [Cadre] = []
        let adresses = adresses?.count == symboles.count ? adresses : nil
        for (rang, ligne) in symboles.enumerated() {
            let morceaux = ligne.split(separator: " ", omittingEmptySubsequences: true)
            guard morceaux.count >= 3 else { continue }
            let module = String(morceaux[1])
            if let ignorer = ignorerModule, module == ignorer { continue }
            var fonction: String?
            if morceaux.count > 3 {
                var reste = morceaux[3...].joined(separator: " ")
                if let plus = reste.range(of: " + ", options: .backwards) { reste = String(reste[..<plus.lowerBound]) }
                fonction = reste.isEmpty ? nil : String(reste.prefix(300))
            }
            var debugId: String?
            if let adresse = adresses?[rang].uintValue, let p = position(adresse) {
                debugId = p.uuid
                /* « MonApp + 123 » : le seul « nom » est celui du binaire, la vraie position est le décalage. */
                if fonction == nil || fonction == module || fonction == p.module { fonction = "+\(p.decalage)" }
            }
            cadres.append(Cadre(fichier: module, fonction: fonction, app: module == moduleApp, debugId: debugId))
            if cadres.count >= Envoi.cadresMax { break }
        }
        return cadres
    }
}
