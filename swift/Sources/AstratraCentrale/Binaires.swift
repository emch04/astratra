import Foundation
#if canImport(MachO)
import MachO
#endif

/// L'identifiant d'un binaire (UUID de Mach-O) et la position d'une adresse dans ce binaire.
///
/// Sans eux, une pile d'une app publiée (symboles retirés) ne dit que « MonApp + 5552808 » : impossible de retrouver la
/// fonction et la ligne. Avec l'UUID, le serveur choisit la table de symboles de CE build (envoyée à la publication) ;
/// avec le décalage, il retrouve la fonction. Comme pour les rapports d'Apple (`binaryUUID`, `offsetIntoBinaryTextSegment`).
enum Binaires {
    struct Position: Equatable, Sendable { let uuid: String; let decalage: UInt; let module: String }

    /// L'UUID d'une image Mach-O chargée (en majuscules, avec tirets), lu dans sa commande de chargement LC_UUID.
    static func uuid(enTete: UnsafeRawPointer) -> String? {
        #if canImport(MachO)
        let entete = enTete.assumingMemoryBound(to: mach_header_64.self).pointee
        guard entete.magic == MH_MAGIC_64 else { return nil }
        var commande = enTete.advanced(by: MemoryLayout<mach_header_64>.size)
        for _ in 0..<entete.ncmds {
            let lc = commande.assumingMemoryBound(to: load_command.self).pointee
            if lc.cmd == UInt32(LC_UUID) {
                let u = commande.assumingMemoryBound(to: uuid_command.self).pointee.uuid
                return UUID(uuid: u).uuidString
            }
            commande = commande.advanced(by: Int(lc.cmdsize))
        }
        #endif
        return nil
    }

    /// Le binaire et le décalage d'une adresse de retour (nil : adresse hors de toute image connue).
    static func position(_ adresse: UInt) -> Position? {
        #if canImport(MachO)
        guard adresse > 0, let pointeur = UnsafeRawPointer(bitPattern: adresse) else { return nil }
        var info = Dl_info()
        guard dladdr(pointeur, &info) != 0, let base = info.dli_fbase, let uuid = uuid(enTete: UnsafeRawPointer(base)) else { return nil }
        let module = info.dli_fname.map { URL(fileURLWithPath: String(cString: $0)).lastPathComponent } ?? "?"
        return Position(uuid: uuid, decalage: adresse - UInt(bitPattern: base), module: module)
        #else
        return nil
        #endif
    }
}
