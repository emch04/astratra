/** An express Router — opaque here, mount it with `app.use(path, router)` (same convention as @astratra/credentials). */
export type Router = unknown;

export type CheckResult = { ok: true } | { ok: false; reason: string };

export const APPLE_WWDR_G4: string;

export interface PassCertificateInfo {
  passTypeIdentifier: string | null;
  teamIdentifier: string | null;
  expiresAt: string;
  x509: unknown;
}

export function readPassCertificate(pem: string): PassCertificateInfo | null;
export function checkAppleCredentials(input: { certificate?: string; privateKey?: string }, now?: number): CheckResult;

export interface GoogleServiceAccount {
  type: 'service_account';
  client_email: string;
  private_key: string;
  [key: string]: unknown;
}

export function readGoogleServiceAccount(json: string | object): GoogleServiceAccount | null;
export function checkGoogleCredentials(input: { issuerId?: string; serviceAccount?: string }): CheckResult;
export function toHexField(text: string): string;
export function fromHexField(value: string | undefined): string | undefined;

export interface PassField {
  key: string;
  label?: string;
  /** A Date is written as ISO 8601 text; use dateStyle / timeStyle to show it as a date. */
  value: string | number | Date;
  attributedValue?: string | number | Date;
  textAlignment?: string;
  changeMessage?: string;
  dateStyle?: 'PKDateStyleNone' | 'PKDateStyleShort' | 'PKDateStyleMedium' | 'PKDateStyleLong' | 'PKDateStyleFull';
  timeStyle?: 'PKDateStyleNone' | 'PKDateStyleShort' | 'PKDateStyleMedium' | 'PKDateStyleLong' | 'PKDateStyleFull';
  [key: string]: unknown;
}

export type BarcodeFormat =
  | 'PKBarcodeFormatQR' | 'PKBarcodeFormatPDF417' | 'PKBarcodeFormatAztec' | 'PKBarcodeFormatCode128'
  /** iOS 27 and later: follow with one of the four formats above for older devices. */
  | 'PKBarcodeFormatCode39' | 'PKBarcodeFormatCodabar' | 'PKBarcodeFormatEAN13' | 'PKBarcodeFormatI2of5';

export interface PassBarcode {
  message: string;
  altText?: string;
  /** QR code unless another format is given. */
  format?: BarcodeFormat;
  /** utf-8 unless another character set is given (iso-8859-1…). */
  messageEncoding?: string;
}

export type TransitType = 'PKTransitTypeAir' | 'PKTransitTypeBoat' | 'PKTransitTypeBus' | 'PKTransitTypeGeneric' | 'PKTransitTypeTrain';

/** ISO 8601 text with time and time zone (2026-12-31T20:30+01:00), or a Date. */
export type PassDate = string | Date;

/**
 * Top-level Apple keys (WalletPasses › Pass), checked then written as is.
 * Given to createApplePasses, they apply to every card; a card replaces them one by one.
 */
export interface ApplePassKeys {
  /** When the card shows on the lock screen: one date, or a start and an end (iOS 18). */
  relevantDates?: Array<{ date: PassDate } | { startDate: PassDate; endDate: PassDate }>;
  /** Older devices (before iOS 18). */
  relevantDate?: PassDate;
  expirationDate?: PassDate;
  /** Up to 10 places where the card shows on the lock screen. */
  locations?: Array<{ latitude: number; longitude: number; altitude?: number; relevantText?: string }>;
  /** Metres. */
  maxDistance?: number;
  beacons?: Array<{ proximityUUID: string; major?: number; minor?: number; relevantText?: string }>;
  /** Tickets of one order shown as a group (event tickets and boarding passes). */
  groupingIdentifier?: string;
  sharingProhibited?: boolean;
  suppressStripShine?: boolean;
  /** Apple semantic tags (eventName, venueName, seats…); Dates become ISO 8601 text. */
  semantics?: Record<string, unknown>;
  /** Hidden data for a companion app. */
  userInfo?: Record<string, unknown>;
  /** For example ['posterEventTicket', 'eventTicket']. */
  preferredStyleSchemes?: string[];
  eventLogoText?: string;
  footerBackgroundColor?: string;
  useAutomaticColors?: boolean;
  suppressHeaderDarkening?: boolean;
  contactVenueEmail?: string;
  contactVenuePhoneNumber?: string;
  transitProviderEmail?: string;
  transitProviderPhoneNumber?: string;
  associatedStoreIdentifiers?: number[];
  auxiliaryStoreIdentifiers?: number[];
  /** Passed to the associated app; a custom scheme is allowed. */
  appLaunchURL?: string;
  nfc?: { message: string; encryptionPublicKey: string; requiresAuthentication?: boolean };
  accessibilityURL?: string;
  addOnURL?: string;
  bagPolicyURL?: string;
  contactVenueWebsite?: string;
  directionsInformationURL?: string;
  merchandiseURL?: string;
  orderFoodURL?: string;
  parkingInformationURL?: string;
  purchaseParkingURL?: string;
  sellURL?: string;
  transferURL?: string;
  transitInformationURL?: string;
  changeSeatURL?: string;
  entertainmentURL?: string;
  managementURL?: string;
  purchaseAdditionalBaggageURL?: string;
  purchaseLoungeAccessURL?: string;
  purchaseWifiURL?: string;
  registerServiceAnimalURL?: string;
  reportLostBagURL?: string;
  requestWheelchairURL?: string;
  trackBagsURL?: string;
  transitProviderWebsiteURL?: string;
  upgradeURL?: string;
  /**
   * Any other pass.json key, written as is (one Apple adds after this version).
   * Cannot replace a key the package writes, nor a key listed above.
   */
  extraKeys?: Record<string, unknown>;
}

export interface PosterGenericFields {
  headerFields?: PassField[];
  primaryFields?: PassField[];
  footerFields?: PassField[];
  backFields?: PassField[];
  additionalInfoFields?: PassField[];
}

export interface PassContent extends ApplePassKeys {
  serialNumber: string;
  /** At least 16 characters (Apple requirement). Required with a webServiceURL; not written without one. */
  authenticationToken?: string;
  headerFields?: PassField[];
  primaryFields?: PassField[];
  secondaryFields?: PassField[];
  auxiliaryFields?: PassField[];
  backFields?: PassField[];
  /** Additional Info section below the card (iOS 18); written only when filled. */
  additionalInfoFields?: PassField[];
  barcode?: PassBarcode;
  /** Several codes, the first one the device can show is shown (instead of barcode). */
  barcodes?: PassBarcode[];
  /** Poster layout (iOS 27), written next to the classic style that older devices keep. Not for boarding passes. */
  posterGeneric?: PosterGenericFields;
  /** Replace the issuer's values for this card. */
  description?: string;
  logoText?: string;
  colors?: { foregroundColor?: string; backgroundColor?: string; labelColor?: string };
  transitType?: TransitType;
  images?: Record<string, Buffer>;
  /** Voided card: Apple Wallet greys it out. The only way for an issuer to retire a card already added. */
  voided?: boolean;
}

export interface ApplePassesOptions extends ApplePassKeys {
  certificate: string;
  privateKey: string;
  passphrase?: string;
  wwdr?: string;
  /** Base of the update web service (Apple adds /v1). Without it, the card is fixed: never updated. */
  webServiceURL?: string;
  organizationName: string;
  description: string;
  /** Shared images; icon.png is required (here or in each card's images). */
  images?: Record<string, Buffer>;
  /** Each colour as rgb(r, g, b). */
  colors?: { foregroundColor?: string; backgroundColor?: string; labelColor?: string };
  type?: 'storeCard' | 'generic' | 'coupon' | 'eventTicket' | 'boardingPass';
  /** Required for a boarding pass. */
  transitType?: TransitType;
  logoText?: string;
}

export interface ApplePasses {
  passTypeIdentifier: string;
  teamIdentifier: string;
  expiresAt: string;
  build(card: PassContent): Buffer;
}

export function createApplePasses(options: ApplePassesOptions): ApplePasses;

export interface ApnsOptions {
  certificate: string;
  privateKey: string;
  passphrase?: string;
  passTypeIdentifier: string;
  connect?: (...args: unknown[]) => unknown;
  host?: string;
}

export function sendApplePassUpdate(pushToken: string, options: ApnsOptions): Promise<number>;

export interface Registration {
  deviceLibraryIdentifier: string;
  passTypeIdentifier: string;
  serialNumber: string;
  pushToken: string;
}

export interface RegistrationStore {
  register(registration: Registration): Promise<boolean>;
  unregister(registration: Omit<Registration, 'pushToken'>): Promise<boolean>;
  listForDevice(deviceLibraryIdentifier: string, passTypeIdentifier: string): Promise<Registration[]>;
  listForPass(passTypeIdentifier: string, serialNumber: string): Promise<Registration[]>;
  forgetPushToken(pushToken: string): Promise<void>;
  /** Deleted card: forget every device registered for it. Returns how many. */
  forgetPass(passTypeIdentifier: string, serialNumber: string): Promise<number>;
}

export function notifyApplePass(options: Omit<ApnsOptions, 'passTypeIdentifier'> & {
  registrations: RegistrationStore;
  passTypeIdentifier: string;
  serialNumber: string;
}): Promise<number>;

export function createMemoryRegistrationStore(): RegistrationStore;
export function createMongooseRegistrationStore(connection: unknown, collection?: string): RegistrationStore;

export function createAppleWebServiceRouter(options: {
  resolveConfig(): Promise<{ passTypeIdentifier: string } | null>;
  findPass(serialNumber: string): Promise<{ authenticationToken: string; updatedAt?: Date | string } | null>;
  buildPass(serialNumber: string): Promise<Buffer>;
  registrations: RegistrationStore;
  logger?: { warn(message: string): void };
}): Router;

export type GoogleKind = 'loyalty' | 'generic' | 'offer' | 'giftCard' | 'eventTicket' | 'flight' | 'transit';

export interface GoogleWallet {
  classId(suffix: string): string;
  objectId(suffix: string): string;
  ensureClass(definition: { id: string; [key: string]: unknown }): Promise<string>;
  upsertObject(object: { id: string; classId: string; [key: string]: unknown }): Promise<string>;
  /** Retire a card: only `state` is sent. False when Google never had it (404). */
  deactivateObject(id: string, state?: 'INACTIVE' | 'EXPIRED'): Promise<boolean>;
  saveLink(objects: Array<{ id: string; classId: string }>, options?: { now?: Date; origins?: string[] }): string;
}

export function createGoogleWallet(options: {
  issuerId: string;
  credentials: { client_email: string; private_key: string };
  kind?: GoogleKind;
  request?: (options: Record<string, unknown>) => Promise<unknown>;
  /** Remplace fetch pour le jeton du compte de service et les appels à Google (essais). */
  fetch?: typeof fetch;
}): GoogleWallet;

export function signSaveJwt(
  payload: Record<string, unknown>,
  credentials: { client_email: string; private_key: string },
  options?: { now?: Date; origins?: string[] }
): string;
