import crypto from "crypto";

/**
 * Canonical Terms & Conditions document for MTOS.
 *
 * This is the single source of truth for the clickwrap agreement presented at
 * first signup. The text is embedded as a constant (rather than read from disk)
 * so it is bundled identically in every environment — dev, worker, and the
 * Railway production build — with no filesystem-path assumptions.
 *
 * When the terms change materially, bump TERMS_VERSION and TERMS_LAST_UPDATED.
 * The acceptance record persisted at registration stores the version + a
 * SHA-256 of the exact text the user agreed to, so a later edit can never
 * silently rewrite what someone accepted.
 *
 * NOTE: the document retains the author's [BRACKETED PLACEHOLDERS] (legal
 * entity name, addresses, governing state, arbitration forum, etc.). Those
 * must be completed by counsel before this is treated as a finalized contract.
 * MTOS is a SaaS platform sold to law firms; it does not practice law and this
 * file is not legal advice.
 */

export const TERMS_VERSION = "1.0";
export const TERMS_EFFECTIVE_DATE = "2026-05-30";
export const TERMS_LAST_UPDATED = "2026-05-30";

const TERMS_CONTENT = `TERMS AND CONDITIONS
MTOS — Mass Tort Operating System
Master Subscription, Platform & Acceptable-Use Agreement
Effective Date: ${"[INSERT EFFECTIVE DATE]"}      Version: [v1.0]      Last Updated: ${"[INSERT DATE]"}
Operated by [LEGAL ENTITY NAME, LLC]  (“Company,” “we,” “us,” “our”)
Registered address: [INSERT REGISTERED ADDRESS]
Jurisdiction of formation: [STATE]
IMPORTANT — READ IN FULL. SECTION 23 REQUIRES MOST DISPUTES TO BE RESOLVED BY BINDING INDIVIDUAL ARBITRATION AND CONTAINS A CLASS-ACTION AND JURY-TRIAL WAIVER. SECTIONS 18–20 LIMIT OUR WARRANTIES AND LIABILITY AND ALLOCATE INDEMNIFICATION RISK TO YOU. BY ACCESSING OR USING THE SERVICES YOU ACCEPT EVERY PROVISION OF THESE TERMS.
Red bracketed fields are placeholders and must be completed before publication. This is a template and is not legal advice; have counsel licensed in your jurisdiction review it before use.

Preamble and Recitals
These Terms and Conditions govern the relationship between the Company and each Customer that accesses the MTOS platform. MTOS is a software-as-a-service platform designed for mass-tort and personal-injury legal-intake operations, including lead capture and qualification, claimant intake, case and matter management, document workflow, communications orchestration, billing, and analytics. The Company licenses access to software; the Company does not practice law, does not provide legal advice, does not solicit clients on any Customer’s behalf, and is not a party to any agreement between a Customer and any claimant, client, attorney, or third party.
The Customer wishes to access the Services, and the Company is willing to provide them, on the terms set out below. In consideration of the mutual promises in these Terms, and intending to be legally bound, the parties agree as follows.

1. Acceptance, Scope, and Order of Precedence
1.1 Acceptance
By creating an account, clicking “I agree,” executing an order form or statement of work, accessing the Services through an API key, or otherwise using the Services, you acknowledge that you have read, understood, and agree to be bound by these Terms and all documents incorporated by reference. If you do not agree, do not access or use the Services.
1.2 Authority to bind
If you accept these Terms on behalf of an entity, you represent and warrant that you have authority to bind that entity, and “you” and “Customer” refer to that entity and its Authorized Users.
1.3 Incorporated documents
These Terms incorporate by reference: (a) the Privacy Policy; (b) the Data Processing Addendum (“DPA”); (c) any Business Associate Agreement (“BAA”); (d) the Acceptable Use Policy (Section 6); (e) any Service Level Agreement (“SLA”); (f) applicable order forms, statements of work, and subscription plans; and (g) any product-specific or beta terms presented to you.
1.4 Order of precedence
In the event of conflict, the following order controls, from highest to lowest: (1) a BAA, solely as to Protected Health Information; (2) a fully executed master agreement signed by both parties, if any; (3) the applicable order form; (4) the DPA; (5) these Terms; (6) the Privacy Policy and all other incorporated policies.
Legal basis:  Online clickwrap and similar agreements are enforceable where the user receives reasonable notice and manifests assent. See Restatement (Second) of Contracts §§ 17, 19; Specht v. Netscape Commc’ns Corp., 306 F.3d 17 (2d Cir. 2002); Meyer v. Uber Techs., Inc., 868 F.3d 66 (2d Cir. 2017). Electronic agreements have legal effect under the E-SIGN Act, 15 U.S.C. § 7001(a), and the Uniform Electronic Transactions Act (UETA).

2. Definitions
Capitalized terms have the meanings set out below or where first defined in these Terms.
“Affiliate” means any entity that controls, is controlled by, or is under common control with a party, where “control” means ownership of more than 50% of the voting interests.
“Authorized User” means an employee, contractor, or agent whom you authorize to use the Services under your account and subject to these Terms.
“Claimant Data” means data relating to a prospective or actual claimant, plaintiff, client, or lead processed through the Services.
“Customer Data” means all data, records, files, and content that you or your Authorized Users submit to, store in, generate within, or process through the Services, including Claimant Data and communications logs.
“Documentation” means the user guides, specifications, and policies the Company makes available for the Services.
“Personal Information / Personal Data” has the meaning given under applicable data-protection law, including the CCPA/CPRA and the GDPR.
“Protected Health Information (PHI)” has the meaning given at 45 C.F.R. § 160.103.
“Processing” means any operation performed on data, including collection, recording, storage, use, disclosure, transmission, and deletion.
“Services” means the MTOS platform, websites, applications, APIs, and related services, together with any updates and Documentation.
“Subscription Term” means the period during which you are licensed to use the Services, as stated in the applicable order form or plan.
“Third-Party Services” means products, integrations, or services provided by entities other than the Company.

3. Eligibility, Accounts, and Authorized Users
3.1 Eligibility
You must be at least 18 years old and able to form a binding contract. The Services are for business and professional use by law firms, lead generators, legal-intake operators, marketing service providers, and their personnel — not for consumers acting in a personal or household capacity.
3.2 Account security
You are responsible for: (a) configuring and safeguarding account credentials and enabling available multi-factor authentication; (b) all activity occurring under your account or API keys, whether or not authorized by you; and (c) promptly notifying us of any actual or suspected unauthorized access. We are not liable for loss arising from your failure to safeguard credentials.
3.3 Authorized Users
You are responsible for your Authorized Users’ compliance with these Terms and for any act or omission by them as if it were your own. Access may not be shared among individuals, and each named seat or license is for a single user unless your plan provides otherwise.
Legal basis:  Unauthorized-access and credential-sharing provisions align with the Computer Fraud and Abuse Act, 18 U.S.C. § 1030, which prohibits access to a protected computer without, or in excess of, authorization.

4. The Services and License Grant
4.1 License
Subject to your compliance with these Terms and payment of all fees, we grant you a limited, non-exclusive, non-transferable, non-sublicensable, revocable license to access and use the Services and Documentation for your internal business purposes during the Subscription Term.
4.2 Editions and changes
Features may vary by edition, tier, or plan. We may add, modify, or discontinue features, provided we do not materially degrade the core functionality of a paid edition during a prepaid term.
4.3 Reservation of rights
Except for the limited license above, the Company and its licensors retain all right, title, and interest in and to the Services, including all software, source code, algorithms, models, machine-learning weights, user interfaces, designs, and Documentation. No rights are granted by implication, estoppel, or otherwise.
Legal basis:  Software and its expression are protected as literary works under the Copyright Act, 17 U.S.C. § 101 et seq.; reservation-of-rights and license-scope terms define and limit the grant.

5. Service Levels, Availability, and Support
5.1 Availability
We will use commercially reasonable efforts to make the Services available consistent with any applicable SLA. Availability targets exclude scheduled maintenance, emergency maintenance, and downtime caused by factors outside our reasonable control or by your equipment, networks, or Third-Party Services.
5.2 Maintenance
We may perform scheduled maintenance with reasonable notice and emergency maintenance without notice where necessary to protect the security or integrity of the Services.
5.3 Support and service credits
Support is provided as described in your plan or SLA. Where an SLA provides service credits, those credits are your sole and exclusive remedy for any failure to meet availability commitments.

6. Acceptable Use Policy
You agree not to, and not to permit any Authorized User or third party to:
use the Services in violation of any applicable law, regulation, court order, or third-party right;
reverse engineer, decompile, disassemble, or attempt to derive source code, models, or weights, except to the extent this restriction is prohibited by law;
copy, frame, mirror, or create derivative works of the Services, or use them to build or train a competing product or model;
resell, sublicense, time-share, or provide the Services to third parties except as expressly permitted;
introduce malware; conduct denial-of-service attacks; probe, scan, or test vulnerabilities; or defeat security, authentication, or rate limits;
scrape, harvest, or extract data other than your own Customer Data through permitted means;
upload unlawful, infringing, defamatory, obscene, harassing, or fraudulent content;
misrepresent your identity or affiliation, or impersonate any person or entity;
use the Services to violate the privacy of, or to stalk, harass, or surveil, any individual;
exceed usage limits or interfere with any other customer’s use of the Services.
We may investigate suspected violations and may suspend or terminate access under Section 22. We may, but are not obligated to, monitor use for security and compliance.
Legal basis:  Anti-intrusion and anti-circumvention terms are supported by the Computer Fraud and Abuse Act, 18 U.S.C. § 1030, and the DMCA anti-circumvention provisions, 17 U.S.C. § 1201; deceptive or unfair conduct is independently actionable under Section 5 of the FTC Act, 15 U.S.C. § 45.

7. Telephone, SMS, Email, and Marketing Compliance
This Section is central to lead-generation and intake use. The Services may facilitate telephone, text-message (SMS/MMS), and email outreach. You — not the Company — are the “seller,” “caller,” “initiator,” and/or “sender” of every communication you originate through or in connection with the Services, and you are solely responsible for compliance with all telemarketing, anti-spam, and consumer-protection laws.
7.1 Consent and do-not-call
For every contact you process or transmit, you represent, warrant, and covenant that you will:
obtain and retain the level of consent the law requires, including prior express written consent for autodialed or prerecorded telemarketing calls and texts to wireless numbers;
scrub against the National Do-Not-Call Registry and all applicable internal, state, and wireless do-not-call lists, and honor every opt-out and revocation immediately;
comply with calling-time restrictions, caller-identification, and call-abandonment rules;
include required identification, opt-out mechanisms, and accurate header and subject lines in commercial email;
not use the Services to send communications to anyone who has revoked consent.
7.2 Caller authentication and records
You are responsible for caller-ID accuracy and for any call-authentication obligations applicable to your traffic, and for maintaining consent records sufficient to demonstrate compliance.
7.3 Allocation of liability
Statutory damages under the TCPA range from $500 to $1,500 per call or message. You acknowledge that you bear sole responsibility for, and will indemnify the Company against, any claim arising from communications you initiate (Section 20).
Legal basis:  Telephone Consumer Protection Act, 47 U.S.C. § 227, and FCC rules at 47 C.F.R. § 64.1200 (consent, revocation, identification, do-not-call); statutory damages at 47 U.S.C. § 227(b)(3) ($500/violation; $1,500 if willful). Telemarketing Sales Rule, 16 C.F.R. Part 310 (including the National Do-Not-Call Registry). CAN-SPAM Act, 15 U.S.C. §§ 7701–7713, and 16 C.F.R. Part 316. Call-authentication framework under the TRACED Act, Pub. L. 116-105, and 47 U.S.C. § 227b (STIR/SHAKEN). State “mini-TCPA” statutes may impose additional requirements.

8. Mass-Tort and Legal-Intake-Specific Provisions
8.1 Company is a technology provider only
The Company provides software. The Company does not practice law, does not provide legal advice, does not refer or solicit clients, and does not exercise judgment over the merits, acceptance, valuation, or handling of any claim. All legal, professional, and ethical responsibility for any matter rests with the responsible attorney and Customer.
8.2 No guarantee of leads, outcomes, or quality
The Company makes no representation or warranty regarding the volume, quality, validity, conversion, retention, or value of any lead, claimant, or case processed through the Services. Analytics, scoring, and qualification outputs are estimates and not guarantees.
8.3 Professional-responsibility compliance
You represent and warrant that your use of the Services complies with all rules of professional conduct and law applicable to lawyers and legal-service providers in each relevant jurisdiction, including rules governing solicitation, advertising, referral arrangements, the unauthorized practice of law, division of fees with non-lawyers, and the use of non-lawyer marketing and intake vendors. You are solely responsible for ensuring that any lead-acquisition, referral, or compensation arrangement you operate through the Services is lawful.
8.4 Anti-runner, anti-capper, and anti-kickback
You will not use the Services to solicit or procure clients through unlawful “runner” or “capper” activity, unlawful in-person solicitation, or any payment that constitutes an unlawful kickback or improper inducement for the referral of legal or healthcare services.
Legal basis:  Professional-responsibility framework reflected in the ABA Model Rules of Professional Conduct, including Rule 5.4 (professional independence; restrictions on fee-sharing with non-lawyers), Rule 7.2 (advertising and referrals), and Rule 7.3 (solicitation), as adopted and modified by each state. Anti-runner/capper statutes (e.g., Cal. Bus. & Prof. Code § 6152) and, where healthcare claims are involved, the federal Anti-Kickback Statute, 42 U.S.C. § 1320a-7b, may apply. Customer bears sole responsibility for compliance.

9. Customer Data — Ownership, License, and Responsibility
9.1 Your ownership
As between the parties, you own and retain all right, title, and interest in your Customer Data. We claim no ownership of it.
9.2 License to operate
You grant the Company a worldwide, non-exclusive, royalty-free license to host, copy, store, transmit, process, analyze, and display Customer Data, and to create de-identified and aggregated data, solely to provide, secure, maintain, and improve the Services and as permitted in the Privacy Policy and DPA. De-identified or aggregated data that cannot reasonably be used to identify any individual or you is not Customer Data.
9.3 Your responsibility for data and lawful basis
You represent and warrant that you have all rights, consents, notices, and lawful bases necessary to collect Customer Data and to have it processed as contemplated by these Terms, and that the Customer Data and its processing do not violate any law or third-party right.
9.4 Accuracy and backups
You are responsible for the accuracy and legality of Customer Data. While we maintain backup practices, you are responsible for retaining your own copies of Customer Data important to you.

10. Privacy and Data Protection
Our collection and use of Personal Information is described in our Privacy Policy, incorporated by reference. Where we process Personal Data on your behalf, we act as a “processor” / “service provider” and you act as the “controller” / “business,” and the DPA governs that processing.
10.1 California (CCPA/CPRA)
We process Personal Information of California residents only as a service provider, for the limited, specified business purposes you direct. We do not “sell” or “share” such information as defined by California law and will not retain, use, or disclose it outside the direct business relationship or for any purpose other than performing the Services.
Legal basis:  California Consumer Privacy Act, as amended by the California Privacy Rights Act, Cal. Civ. Code § 1798.100 et seq.; service-provider obligations at § 1798.140(ag) and § 1798.100(d).
10.2 Other U.S. state privacy laws
Where applicable, we comply with comprehensive state privacy laws as a processor and will assist you with consumer-rights requests as required.
Legal basis:  E.g., Virginia Consumer Data Protection Act (Va. Code § 59.1-575 et seq.); Colorado Privacy Act (C.R.S. § 6-1-1301 et seq.); Connecticut Data Privacy Act; Utah Consumer Privacy Act; Texas Data Privacy and Security Act.
10.3 EEA / UK (GDPR)
Where the EU or UK GDPR applies, the parties comply with the DPA, including processor obligations and the use of Standard Contractual Clauses for any restricted international transfer.
Legal basis:  Regulation (EU) 2016/679 (GDPR), Articles 28 (processors) and 44–46 (transfers); UK GDPR and the Data Protection Act 2018.
10.4 Protected Health Information (HIPAA)
If, in providing the Services, we create, receive, maintain, or transmit PHI on your behalf and you are a covered entity or business associate, the parties will execute a BAA, which controls over any conflicting term as to PHI.
Legal basis:  HIPAA and the HITECH Act; Privacy, Security, and Breach Notification Rules at 45 C.F.R. Parts 160 and 164; business-associate requirements at 45 C.F.R. § 164.504(e).
10.5 Other regulated data
You are responsible for determining whether financial, credit, children’s, or other specially regulated data may lawfully be processed through the Services and for any additional obligations that apply to it.
Legal basis:  E.g., Gramm-Leach-Bliley Act, 15 U.S.C. § 6801 et seq. (financial data); Fair Credit Reporting Act, 15 U.S.C. § 1681 et seq.; Children’s Online Privacy Protection Act, 15 U.S.C. §§ 6501–6506, and 16 C.F.R. Part 312.
10.6 Security program
We maintain a written information-security program with administrative, technical, and physical safeguards designed to protect Customer Data, appropriate to the nature of the data and the risks involved.
10.7 Subprocessors
You authorize us to engage subprocessors to support the Services, subject to written terms no less protective than the DPA. A current list is available on request or as posted.
10.8 Security incidents and breach notification
Upon confirming a security incident affecting your Customer Data, we will notify you without undue delay and cooperate as reasonably required for your own notification obligations.
Legal basis:  Breach-notification duties arise under state data-breach statutes (e.g., Cal. Civ. Code §§ 1798.29, 1798.82), the HIPAA Breach Notification Rule (45 C.F.R. §§ 164.400–414), and GDPR Articles 33–34.

11. Electronic Communications and Consent
You consent to receive communications from us electronically, including service, account, security, and legal notices. You agree that electronic agreements, notices, disclosures, and records satisfy any legal requirement that such communications be in writing, and that electronic signatures are valid and binding.
Legal basis:  E-SIGN Act, 15 U.S.C. § 7001, and UETA, give electronic records and signatures the same legal effect as paper when consent requirements are met.

12. Intellectual Property, Feedback, and Copyright Complaints
12.1 Ownership
The Services and all related software, models, trademarks, logos, and content (excluding Customer Data) are owned by the Company or its licensors and protected by intellectual-property laws.
12.2 Feedback
If you provide suggestions, ideas, or feedback, you grant the Company a perpetual, irrevocable, worldwide, royalty-free, sublicensable license to use them without restriction or compensation.
12.3 Trademarks
You may not use our trademarks without prior written consent except as needed to identify the Services factually.
12.4 DMCA
We respond to notices of alleged copyright infringement under the DMCA. Send notices to our designated agent at [DMCA AGENT NAME / EMAIL / ADDRESS]. We may remove allegedly infringing material and terminate repeat infringers.
Legal basis:  DMCA safe harbor and notice-and-takedown procedure, 17 U.S.C. § 512; trademark protection under the Lanham Act, 15 U.S.C. § 1051 et seq.

13. Third-Party Services and APIs
The Services may interoperate with Third-Party Services (e.g., data-enrichment, communications, payment, e-signature, or CRM connectors). Your use of any Third-Party Service is governed by that provider’s terms; we do not control and are not responsible for Third-Party Services and disclaim all liability arising from them to the maximum extent permitted by law. Use of our API is subject to any published API terms and rate limits, and you must not use the API to circumvent these Terms.

14. Artificial Intelligence and Automated Features
The Services may include AI or machine-learning features that generate summaries, classifications, scores, drafts, or other output. Such output is probabilistic, may be inaccurate or incomplete, and is provided for your evaluation only.
AI output is not legal, medical, financial, or professional advice and must be reviewed by a qualified human before reliance or use;
you are responsible for any decision made or action taken based on AI output;
you will not submit to AI features any data you lack the right to process, and you remain responsible for compliance with Sections 9 and 10;
unless separately agreed in writing, we do not use your Customer Data to train models for the benefit of other customers, except in de-identified, aggregated form as permitted in Section 9.2.
Legal basis:  Disclaimers regarding accuracy and reliance support the warranty and liability allocations in Sections 18–19; unfair or deceptive representations about automated output are independently regulated under Section 5 of the FTC Act, 15 U.S.C. § 45.

15. Fees, Billing, Renewal, and Taxes
15.1 Fees
You will pay all fees stated in the applicable order form or plan. Except as expressly stated, fees are non-cancelable and payments are non-refundable.
15.2 Auto-renewal
Unless an order form states otherwise, subscriptions renew automatically for successive periods equal to the prior term unless either party gives written notice of non-renewal at least 30 days before the end of the then-current term. We may adjust renewal pricing with prior notice.
15.3 Late payment and suspension
Overdue amounts accrue interest at the lesser of 1.5% per month or the maximum rate permitted by law, plus reasonable collection costs. We may suspend the Services for non-payment after reasonable notice.
15.4 Taxes
Fees are exclusive of taxes. You are responsible for all sales, use, VAT, GST, and similar taxes, excluding taxes on our net income.
15.5 Disputes and chargebacks
You must notify us of any good-faith billing dispute within 30 days of the invoice date; undisputed amounts remain due. Initiating a chargeback for properly owed amounts is a breach of these Terms.
Legal basis:  Interest and late-fee provisions are capped by applicable state usury statutes; this clause defers to the maximum lawful rate. Automatic-renewal terms may be subject to state automatic-renewal laws (e.g., Cal. Bus. & Prof. Code § 17600 et seq.) where they apply.

16. Free Trials, Beta, and Evaluation Services
We may offer free trials or beta, preview, or evaluation features (“Beta Services”). Beta Services are provided “AS IS,” may be changed or withdrawn at any time, are excluded from any SLA, and may carry additional or different terms. To the maximum extent permitted by law, we have no liability for Beta Services.

17. Confidentiality
“Confidential Information” means non-public information disclosed by one party that is marked or reasonably understood to be confidential, including the Services’ non-public features, pricing, and Customer Data. The receiving party will: (a) use Confidential Information only to perform under these Terms; (b) protect it with at least reasonable care; and (c) limit access to personnel and advisors with a need to know who are bound by confidentiality obligations.
Confidentiality obligations do not apply to information that is public through no breach, independently developed, or rightfully received from a third party, and do not prevent disclosure required by law or legal process, provided the receiving party gives prompt notice where lawful and cooperates in seeking protective treatment.

18. Representations, Warranties, and Disclaimers
18.1 Mutual
Each party represents that it has the authority to enter into these Terms and will comply with laws applicable to its performance.
18.2 Disclaimer
EXCEPT AS EXPRESSLY STATED IN THESE TERMS, THE SERVICES, INCLUDING ALL CONTENT, DATA, AND AI OUTPUT, ARE PROVIDED “AS IS” AND “AS AVAILABLE,” WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY. THE COMPANY DISCLAIMS ALL IMPLIED WARRANTIES, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, ACCURACY, AND NON-INFRINGEMENT. THE COMPANY DOES NOT WARRANT THAT THE SERVICES WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE, THAT DEFECTS WILL BE CORRECTED, OR THAT ANY DATA OR RESULT WILL BE ACCURATE, COMPLETE, OR PRESERVED.
Legal basis:  Disclaimers of implied warranties are permitted when conspicuous, per UCC § 2-316. Some jurisdictions do not allow the exclusion of certain implied warranties, so portions of this Section may not apply to you.

19. Limitation of Liability
TO THE MAXIMUM EXTENT PERMITTED BY LAW: (a) NEITHER PARTY WILL BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, REVENUE, GOODWILL, OR DATA, EVEN IF ADVISED OF THE POSSIBILITY; AND (b) THE COMPANY’S TOTAL AGGREGATE LIABILITY ARISING OUT OF OR RELATING TO THESE TERMS WILL NOT EXCEED THE AMOUNTS PAID BY YOU TO THE COMPANY FOR THE SERVICES IN THE TWELVE (12) MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM.
These limitations form an essential basis of the bargain and apply regardless of the theory of liability. They do not limit liability that cannot be limited by law, such as for a party’s gross negligence or willful misconduct, or your payment and indemnification obligations.
Legal basis:  Limitation and exclusion of consequential damages is permitted unless unconscionable, per UCC § 2-719. Carve-outs reflect that liability for gross negligence or willful misconduct generally cannot be disclaimed as a matter of public policy.

20. Indemnification
20.1 By you
You will defend, indemnify, and hold harmless the Company and its Affiliates, officers, directors, employees, and agents from any third-party claim, loss, liability, damage, fine, penalty, or expense (including reasonable attorneys’ fees) arising out of or related to: (a) your Customer Data; (b) your communications, marketing, telemarketing, or solicitation activity, including any TCPA, Telemarketing Sales Rule, CAN-SPAM, do-not-call, or state mini-TCPA claim; (c) your violation of these Terms or applicable law, including professional-responsibility, anti-runner/capper, or anti-kickback laws; (d) your infringement or misappropriation of any third-party right; or (e) your use of the Services in combination with any product or data not provided by the Company.
20.2 By us
We will defend you against any third-party claim that the Services, as provided by us and used in accordance with these Terms, infringe that third party’s U.S. intellectual-property right, and will pay resulting costs and damages finally awarded or agreed in settlement, subject to Section 19. This obligation does not apply to claims arising from Customer Data, Third-Party Services, modifications not made by us, or use in violation of these Terms.
20.3 Procedure
The indemnified party will give prompt notice, allow the indemnifying party to control the defense, and reasonably cooperate. No settlement imposing liability or admission on the indemnified party may be made without its consent.
Legal basis:  Indemnity for telemarketing exposure tracks TCPA per-violation liability (47 U.S.C. § 227(b)(3)); IP-infringement indemnity is a standard allocation of risk in software licensing.

21. Insurance
If your use of the Services involves regulated communications or large volumes of Personal Information or PHI, you will maintain commercially reasonable insurance, which may include commercial general liability, professional liability (errors and omissions), and cyber-liability coverage, and will provide evidence on reasonable request.

22. Term, Suspension, and Termination
22.1 Term
These Terms begin when you first accept them and continue for the Subscription Term and any renewals, until terminated as provided here.
22.2 Termination for cause
Either party may terminate for the other’s material breach that remains uncured 30 days after written notice. We may terminate immediately if you breach Sections 6, 7, or 8, infringe our intellectual property, or create a security, legal, or reputational risk.
22.3 Suspension
We may suspend your access immediately, in whole or in part, for non-payment, suspected security threats, or suspected violation of Sections 6–8, and will restore access promptly once the cause is resolved.
22.4 Effect of termination
On termination your license ends and you must cease using the Services. You may export your Customer Data for 30 days after termination, after which we may delete it in the ordinary course, subject to legal-retention requirements and backup cycles. Termination does not relieve you of accrued payment obligations.
22.5 Survival
Sections that by their nature should survive (including Sections 9, 12, 17, 18–23, and 25–33) survive termination.

23. Dispute Resolution — Arbitration, Class Waiver, and Jury Waiver
PLEASE READ THIS SECTION CAREFULLY. IT REQUIRES MOST DISPUTES TO BE RESOLVED BY BINDING INDIVIDUAL ARBITRATION AND WAIVES YOUR RIGHT TO A JURY TRIAL AND TO PARTICIPATE IN A CLASS OR REPRESENTATIVE ACTION.
23.1 Informal resolution
Before initiating arbitration, the parties will attempt in good faith to resolve any dispute through written notice and a 30-day informal-resolution period.
23.2 Binding arbitration
Any dispute arising out of or relating to these Terms or the Services that is not resolved informally will be resolved by final and binding arbitration administered by [AAA / JAMS] under its then-current commercial rules, before a single arbitrator, seated in [CITY, STATE]. Judgment on the award may be entered in any court of competent jurisdiction.
23.3 Class-action and jury waiver
All claims must be brought in the parties’ individual capacity and not as a plaintiff or class member in any purported class, collective, consolidated, or representative proceeding. The arbitrator may not consolidate or preside over claims of more than one person. Each party waives any right to a jury trial.
23.4 Exceptions
Either party may (a) bring an individual claim in small-claims court, or (b) seek injunctive or equitable relief in court to protect intellectual property or Confidential Information.
23.5 Opt-out
You may opt out of this arbitration agreement by written notice to [OPT-OUT EMAIL/ADDRESS] within 30 days of first accepting these Terms; opting out does not affect any other provision.
Legal basis:  The Federal Arbitration Act, 9 U.S.C. §§ 1–16, makes written arbitration agreements valid and enforceable. Class-action waivers in arbitration are enforceable per AT&T Mobility LLC v. Concepcion, 563 U.S. 333 (2011); American Express Co. v. Italian Colors Restaurant, 570 U.S. 228 (2013); and Epic Systems Corp. v. Lewis, 584 U.S. 497 (2018).

24. Governing Law and Venue
These Terms are governed by the laws of the State of [GOVERNING STATE], excluding its conflict-of-laws rules. Subject to Section 23, the parties consent to the exclusive jurisdiction and venue of the state and federal courts located in [COUNTY, STATE]. The U.N. Convention on Contracts for the International Sale of Goods does not apply.

25. Export Control and Economic Sanctions
You will comply with all applicable export-control and sanctions laws. You represent that you are not located in, organized under the laws of, or ordinarily resident in any embargoed or sanctioned jurisdiction, are not a restricted or denied party, and will not use or export the Services in violation of such laws.
Legal basis:  U.S. Export Administration Regulations, 15 C.F.R. Parts 730–774; International Traffic in Arms Regulations, 22 C.F.R. Parts 120–130 (if applicable); economic-sanctions programs administered by the U.S. Treasury Office of Foreign Assets Control under 31 C.F.R. Chapter V.

26. Anti-Corruption
Each party will comply with all applicable anti-corruption and anti-bribery laws and will not offer, give, or accept any bribe or improper payment in connection with these Terms.
Legal basis:  U.S. Foreign Corrupt Practices Act, 15 U.S.C. §§ 78dd-1 et seq.; and other applicable anti-bribery laws such as the UK Bribery Act 2010 where relevant.

27. Recording and Monitoring of Communications
If you use the Services to record or monitor calls or messages, you are solely responsible for providing all legally required notices and obtaining all legally required consents, including in jurisdictions that require the consent of all parties to a communication.
Legal basis:  Federal one-party-consent rule under the Wiretap Act, 18 U.S.C. § 2511; many states require all-party consent (e.g., California Penal Code § 632). Customer bears sole responsibility for compliance.

28. Accessibility
We endeavor to make the Services usable and to work toward recognized accessibility guidelines. You are responsible for the accessibility of any content and intake experiences you configure for your own end users.
Legal basis:  Accessibility considerations reference the Americans with Disabilities Act, 42 U.S.C. § 12181 et seq.; Section 508 of the Rehabilitation Act, 29 U.S.C. § 794d (for federal contexts); and the WCAG guidelines as a common standard.

29. U.S. Government End Users
The Services are “commercial computer software” and “commercial computer software documentation.” Any use, duplication, or disclosure by the U.S. Government is subject to the restrictions in these Terms and is governed solely by them.
Legal basis:  FAR 12.212 and DFARS 227.7202, governing the acquisition of commercial computer software by the U.S. Government.

30. Force Majeure
Neither party is liable for any delay or failure to perform (other than payment obligations) caused by events beyond its reasonable control, including acts of God, natural disaster, war, terrorism, civil unrest, labor disputes, governmental action, internet or utility failures, denial-of-service attacks, or failures of Third-Party Services.

31. Changes to the Terms and the Services
We may modify these Terms from time to time. We will post the updated Terms with a revised “Last Updated” date and, for material changes, provide reasonable advance notice (such as by email or in-product notice). Your continued use of the Services after the effective date constitutes acceptance. If you object, your remedy is to stop using the Services and, where applicable, terminate under Section 22. We may also modify the Services as described in Section 4.2.

32. Notices
Legal notices to the Company must be in writing and sent to [LEGAL NOTICE EMAIL] and, if requested, by mail to [LEGAL NOTICE ADDRESS]. Notices to you may be sent to the email or account address on file. Notices are effective on receipt or, for email, on confirmed transmission.

33. General Provisions
33.1 Entire agreement
These Terms, with all incorporated documents, are the entire agreement between the parties and supersede all prior or contemporaneous understandings on the subject. Any purchase-order or vendor terms you issue are rejected and have no effect.
33.2 Severability
If any provision is held unenforceable, the remaining provisions remain in effect and the unenforceable provision will be modified to the minimum extent necessary to make it enforceable. If the class-action waiver in Section 23 is held unenforceable as to a claim, that claim will proceed in court and the remainder of Section 23 will continue to apply.
33.3 No waiver
Failure to enforce any provision is not a waiver of the right to enforce it later.
33.4 Assignment
You may not assign or transfer these Terms without our prior written consent; any attempted assignment in violation is void. We may assign these Terms in connection with a merger, acquisition, reorganization, or sale of assets. These Terms bind and benefit permitted successors and assigns.
33.5 Relationship of the parties
The parties are independent contractors. Nothing creates a partnership, joint venture, agency, fiduciary, or employment relationship, and neither party may bind the other.
33.6 Third-party beneficiaries
There are no third-party beneficiaries except for the indemnified parties named in Section 20.
33.7 Publicity
Neither party will use the other’s name or marks in publicity without prior written consent, except that we may identify you as a customer in customer lists unless you opt out in writing.
33.8 Audit and compliance
On reasonable notice, we may verify your compliance with license scope and Sections 6–8; you will reasonably cooperate. We may also disclose information as required to comply with law or valid legal process.
33.9 Interpretation
Headings are for convenience only. “Including” means “including without limitation.” These Terms will not be construed against the drafter.
33.10 Counterparts and electronic acceptance
These Terms may be accepted electronically and in counterparts, each of which is an original and together one instrument.

34. Contact
Questions about these Terms may be directed to:
[LEGAL ENTITY NAME]
[ADDRESS]
Email: [CONTACT EMAIL]    Phone: [PHONE]
Statutory and case citations refer to authorities in effect as of drafting and are provided to indicate the legal foundation of each provision. Verify current text, jurisdiction, and applicability with counsel licensed in your jurisdiction before publication. This template does not create an attorney-client relationship.`;

let cachedSha: string | null = null;

function termsSha(): string {
  if (cachedSha === null) {
    cachedSha = crypto.createHash("sha256").update(TERMS_CONTENT, "utf8").digest("hex");
  }
  return cachedSha;
}

export interface TermsDocument {
  version: string;
  effective_date: string;
  last_updated: string;
  content: string;
  sha256: string;
}

/** Returns the current canonical Terms & Conditions with its content hash. */
export function getTermsDocument(): TermsDocument {
  return {
    version: TERMS_VERSION,
    effective_date: TERMS_EFFECTIVE_DATE,
    last_updated: TERMS_LAST_UPDATED,
    content: TERMS_CONTENT,
    sha256: termsSha(),
  };
}

/** Lightweight metadata (no body) — used when recording an acceptance. */
export function getTermsMeta(): Pick<TermsDocument, "version" | "sha256" | "effective_date"> {
  return { version: TERMS_VERSION, sha256: termsSha(), effective_date: TERMS_EFFECTIVE_DATE };
}
