import {
  checkAppleCredentials, checkGoogleCredentials, createApplePasses, createAppleWebServiceRouter,
  createGoogleWallet, createMemoryRegistrationStore, fromHexField, readPassCertificate, toHexField
} from './src';
import type { CheckResult, PassContent, RegistrationStore } from './src';

declare const pem: string;
declare const key: string;

const check: CheckResult = checkAppleCredentials({ certificate: pem, privateKey: key });
const googleCheck: CheckResult = checkGoogleCredentials({ issuerId: '3388000000000000000' });
const info = readPassCertificate(pem);
const passes = createApplePasses({
  certificate: pem, privateKey: key, webServiceURL: 'https://api.example.com/wallet/apple',
  organizationName: 'Salon', description: 'Carte fidélité'
});
const card: PassContent = { serialNumber: 'C-1', authenticationToken: 'jeton-assez-long-123', barcode: { message: 'C-1' } };
const buffer: Buffer = passes.build(card);
const fixe = createApplePasses({ certificate: pem, privateKey: key, organizationName: 'Salon', description: 'Carte de visite' });
const carteFixe: Buffer = fixe.build({ serialNumber: 'S-1', barcode: { message: 'https://example.com', format: 'PKBarcodeFormatAztec' } });
const theatre = createApplePasses({
  certificate: pem, privateKey: key, organizationName: 'Théâtre', description: 'Billet', type: 'eventTicket',
  locations: [{ latitude: 43.29, longitude: 5.37, relevantText: 'Vous arrivez' }], sharingProhibited: true
});
const billet: Buffer = theatre.build({
  serialNumber: 'B-1',
  primaryFields: [{ key: 'spectacle', value: 'Le Cid' }],
  auxiliaryFields: [{ key: 'date', value: new Date(), dateStyle: 'PKDateStyleMedium' }],
  additionalInfoFields: [{ key: 'portes', label: 'PORTES', value: '19 h' }],
  relevantDates: [{ startDate: '2026-12-31T19:00+01:00', endDate: new Date() }],
  groupingIdentifier: 'commande-42',
  semantics: { eventName: 'Le Cid' },
  preferredStyleSchemes: ['posterEventTicket', 'eventTicket'],
  barcodes: [{ message: '4006381333931', format: 'PKBarcodeFormatEAN13' }, { message: 'B-1' }],
  extraKeys: { featuredActions: [] }
});
const train = createApplePasses({
  certificate: pem, privateKey: key, organizationName: 'Rail', description: 'Billet', type: 'boardingPass', transitType: 'PKTransitTypeTrain'
});
const embarquement: Buffer = train.build({ serialNumber: 'T-1', transitType: 'PKTransitTypeBus' });
const billetsGoogle = createGoogleWallet({ issuerId: '3388', credentials: { client_email: 'a@b.c', private_key: key }, kind: 'eventTicket' });
const registrations: RegistrationStore = createMemoryRegistrationStore();
const router = createAppleWebServiceRouter({
  resolveConfig: async () => ({ passTypeIdentifier: passes.passTypeIdentifier }),
  findPass: async () => ({ authenticationToken: 'jeton-assez-long-123' }),
  buildPass: async () => buffer,
  registrations
});
const google = createGoogleWallet({ issuerId: '3388', credentials: { client_email: 'a@b.c', private_key: key } });
const link: string = google.saveLink([{ id: google.objectId('C-1'), classId: google.classId('fidelite') }]);
const hex: string = toHexField(pem);
const back: string | undefined = fromHexField(hex);

export { check, googleCheck, info, router, link, back, carteFixe, billet, embarquement, billetsGoogle };
