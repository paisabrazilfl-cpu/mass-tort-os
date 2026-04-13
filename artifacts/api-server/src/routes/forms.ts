import { Router } from "express";
import { db, leadsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { validateEmail } from "../lib/email-validator";
import { validateAddress } from "../lib/address-validator";
import { runBackgroundCheck } from "../lib/background-check";
import { runFullConflictCheck, routeToReview } from "../lib/conflict-engine";
import { auditLog } from "../lib/audit";
import { logger } from "../lib/logger";

const router = Router();

const TORT_CONFIGS: Record<string, { label: string; fields: string[]; rules: string[] }> = {
  "camp-lejeune": {
    label: "Camp Lejeune",
    fields: ["location_name", "exposure_start", "exposure_end"],
    rules: ["LOCATION_REQUIRED", "EXPOSURE_DATES_REQUIRED"],
  },
  "afff": {
    label: "AFFF Firefighting Foam",
    fields: ["location_name", "exposure_start"],
    rules: ["LOCATION_REQUIRED"],
  },
  "nec": {
    label: "Necrotizing Enterocolitis",
    fields: [],
    rules: [],
  },
  "roundup": {
    label: "Roundup",
    fields: ["exposure_start"],
    rules: [],
  },
  "talcum-powder": {
    label: "Talcum Powder",
    fields: [],
    rules: [],
  },
  "asbestos": {
    label: "Asbestos",
    fields: ["location_name", "exposure_start", "exposure_end"],
    rules: ["LOCATION_REQUIRED", "EXPOSURE_DATES_REQUIRED"],
  },
  "paraquat": {
    label: "Paraquat",
    fields: ["exposure_start"],
    rules: [],
  },
  "zantac": {
    label: "Zantac",
    fields: [],
    rules: [],
  },
  "hair-relaxer": {
    label: "Hair Relaxer",
    fields: [],
    rules: [],
  },
  "tylenol": {
    label: "Tylenol",
    fields: [],
    rules: [],
  },
};

router.get("/config", (_req, res) => {
  const configs = Object.entries(TORT_CONFIGS).map(([id, config]) => ({
    id,
    ...config,
  }));
  res.json({ tort_campaigns: configs });
});

router.get("/config/:tortId", (req, res) => {
  const config = TORT_CONFIGS[req.params.tortId];
  if (!config) {
    res.status(404).json({ error: "Tort campaign not found" });
    return;
  }
  res.json({ id: req.params.tortId, ...config });
});

router.post("/validate/email", (req, res) => {
  const { email } = req.body;
  const result = validateEmail(email);
  res.json(result);
});

router.post("/validate/address", (req, res) => {
  const result = validateAddress(req.body);
  res.json(result);
});

router.get("/embed/:tortId", (req, res) => {
  const tortId = req.params.tortId;
  const config = TORT_CONFIGS[tortId];
  if (!config) {
    res.status(404).json({ error: "Tort campaign not found" });
    return;
  }

  const host = req.get("host") || "localhost";
  const protocol = req.get("x-forwarded-proto") || req.protocol;
  const baseUrl = `${protocol}://${host}`;

  const embedScript = generateEmbedScript(tortId, config, baseUrl);
  res.setHeader("Content-Type", "application/javascript");
  res.send(embedScript);
});

router.post("/submit", async (req, res) => {
  const data = req.body;
  const errors: string[] = [];

  const requiredFields = [
    "first_name", "last_name", "date_of_birth", "street_address", "city",
    "state", "zip", "phone_primary", "email", "last_4_ssn",
    "diagnosis", "diagnosis_date",
    "physician_first_name", "physician_last_name", "physician_full_address", "physician_contact_info",
    "hospital_name", "hospital_fax", "hospital_contact_info",
    "tort_type",
  ];

  for (const field of requiredFields) {
    if (!data[field] || (typeof data[field] === "string" && !data[field].trim())) {
      errors.push(`MISSING_${field.toUpperCase()}`);
    }
  }

  if (errors.length > 0) {
    res.status(422).json({ status: "REJECTED", errors, action: "FIX_AND_RESUBMIT" });
    return;
  }

  const emailResult = validateEmail(data.email);
  if (!emailResult.valid) {
    errors.push(...emailResult.errors.map((e: string) => `INVALID_EMAIL:${e}`));
  }

  const addressResult = validateAddress({
    street_address: data.street_address,
    city: data.city,
    state: data.state,
    zip: data.zip,
  });
  if (!addressResult.valid) {
    errors.push(...addressResult.errors.map((e: string) => `INVALID_ADDRESS:${e}`));
  }

  if (!data.tcpa_consent || data.tcpa_consent !== true) {
    errors.push("MISSING_TCPA_CONSENT");
  }

  if (!data.trustedform_cert_url || typeof data.trustedform_cert_url !== "string" || !data.trustedform_cert_url.startsWith("https://cert.trustedform.com/")) {
    errors.push("MISSING_OR_INVALID_TRUSTEDFORM");
  }

  const tortKey = Object.keys(TORT_CONFIGS).find(
    k => TORT_CONFIGS[k].label === data.tort_type || k === data.tort_type
  );
  if (tortKey) {
    const tortConfig = TORT_CONFIGS[tortKey];
    for (const rule of tortConfig.rules) {
      if (rule === "LOCATION_REQUIRED" && (!data.location_name || !data.location_name.trim())) {
        errors.push("TORT_RULE:LOCATION_REQUIRED");
      }
      if (rule === "EXPOSURE_DATES_REQUIRED" && (!data.exposure_start || !data.exposure_start.trim())) {
        errors.push("TORT_RULE:EXPOSURE_DATES_REQUIRED");
      }
    }
  }

  if (errors.length > 0) {
    res.status(422).json({ status: "REJECTED", errors, action: "FIX_AND_RESUBMIT" });
    return;
  }

  const fullName = `${data.first_name} ${data.last_name}`.trim();

  const conflictCheck = await runFullConflictCheck({
    entity_type: "lead",
    entity_id: "pending",
    source_module: "form_engine",
    lead_data: { ...data, name: fullName },
  });

  if (conflictCheck.has_conflict && conflictCheck.output_state === "REJECT") {
    await auditLog("lead", "rejected", "form_engine_conflict", {
      conflict_type: conflictCheck.conflict_type,
      details: conflictCheck.details,
    });
    res.status(422).json({
      status: "REJECTED",
      errors: [`CONFLICT:${conflictCheck.conflict_type}`],
      details: conflictCheck.details,
      action: "REJECTED",
    });
    return;
  }

  let status = "new";
  if (conflictCheck.has_conflict && conflictCheck.output_state === "REVIEW_REQUIRED") {
    status = "review_required";
  }
  if (!data.diagnosis_confirmed || !data.was_at_location) {
    status = "rejected";
  }

  try {
    const [lead] = await db
      .insert(leadsTable)
      .values({
        name: fullName,
        email: data.email,
        phone: data.phone_primary,
        tort_type: data.tort_type,
        first_name: data.first_name,
        last_name: data.last_name,
        date_of_birth: data.date_of_birth,
        street_address: data.street_address,
        city: data.city,
        state: data.state,
        zip: data.zip,
        phone_primary: data.phone_primary,
        last_4_ssn: data.last_4_ssn,
        diagnosis: data.diagnosis,
        diagnosis_date: data.diagnosis_date,
        diagnosis_confirmed: data.diagnosis_confirmed ?? false,
        was_at_location: data.was_at_location ?? false,
        location_name: data.location_name ?? null,
        physician_first_name: data.physician_first_name,
        physician_last_name: data.physician_last_name,
        physician_full_address: data.physician_full_address,
        physician_contact_info: data.physician_contact_info,
        hospital_name: data.hospital_name,
        hospital_fax: data.hospital_fax,
        hospital_contact_info: data.hospital_contact_info,
        tcpa_consent: true,
        trustedform_cert_url: data.trustedform_cert_url,
        trustedform_ip: data.trustedform_ip ?? null,
        trustedform_user_agent: data.trustedform_user_agent ?? null,
        trustedform_timestamp: data.trustedform_timestamp ? new Date(data.trustedform_timestamp) : new Date(),
        email_validation_status: "valid",
        address_validation_status: "valid",
        exposure_start: data.exposure_start ?? null,
        exposure_end: data.exposure_end ?? null,
        diagnosis_type: data.diagnosis_type ?? null,
        notes: data.notes ?? null,
        ad_spend: data.ad_spend ? String(data.ad_spend) : null,
        source: data.source ?? "form_embed",
        status,
      })
      .returning();

    if (status === "review_required") {
      try {
        const { reviewQueueTable } = await import("@workspace/db");
        const { and: andOp } = await import("drizzle-orm");
        await db
          .update(reviewQueueTable)
          .set({ entity_id: String(lead.id) })
          .where(
            andOp(
              eq(reviewQueueTable.entity_id, "pending"),
              eq(reviewQueueTable.entity_type, "lead"),
              eq(reviewQueueTable.source_module, "form_engine")
            )
          );
      } catch (_) {}
    }

    await auditLog("lead", String(lead.id), "form_submission", {
      source: "form_engine",
      status,
      trustedform_cert_url: data.trustedform_cert_url,
    });

    let bgCheck = null;
    try {
      bgCheck = await runBackgroundCheck({
        first_name: data.first_name,
        last_name: data.last_name,
        state: data.state,
        date_of_birth: data.date_of_birth,
      });

      await db
        .update(leadsTable)
        .set({
          background_check_status: bgCheck.status,
          background_check_data: JSON.stringify(bgCheck),
          updated_at: new Date(),
        })
        .where(eq(leadsTable.id, lead.id));
    } catch (bgErr) {
      logger.warn({ err: bgErr, leadId: lead.id }, "Background check failed post-insert");
    }

    res.status(201).json({
      status: "ACCEPTED",
      lead_id: lead.id,
      lead_status: status,
      background_check: bgCheck ? { status: bgCheck.status, summary: bgCheck.summary } : null,
      output_state: status === "review_required" ? "REVIEW_REQUIRED" : status === "rejected" ? "REJECT" : "ACCEPT",
    });
  } catch (err) {
    logger.error({ err }, "Form submission insert failed");
    res.status(500).json({ status: "ERROR", errors: ["INTERNAL_ERROR"], action: "RETRY" });
  }
});

router.post("/background-check", async (req, res) => {
  const { first_name, last_name, state, date_of_birth } = req.body;
  if (!first_name || !last_name) {
    res.status(400).json({ error: "first_name and last_name are required" });
    return;
  }

  const result = await runBackgroundCheck({ first_name, last_name, state, date_of_birth });
  res.json(result);
});

router.post("/background-check/lead/:id", async (req, res) => {
  const leadId = Number(req.params.id);
  if (isNaN(leadId)) {
    res.status(400).json({ error: "Invalid lead ID" });
    return;
  }

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  if (!lead.first_name || !lead.last_name) {
    res.status(422).json({ error: "Lead missing first_name or last_name" });
    return;
  }

  const result = await runBackgroundCheck({
    first_name: lead.first_name,
    last_name: lead.last_name,
    state: lead.state ?? undefined,
    date_of_birth: lead.date_of_birth ?? undefined,
  });

  await db
    .update(leadsTable)
    .set({
      background_check_status: result.status,
      background_check_data: JSON.stringify(result),
      updated_at: new Date(),
    })
    .where(eq(leadsTable.id, leadId));

  await auditLog("lead", String(leadId), "background_check", {
    status: result.status,
    records_found: result.records.length,
  });

  res.json(result);
});

function generateEmbedScript(tortId: string, config: { label: string; fields: string[]; rules: string[] }, baseUrl: string): string {
  const allStates = '["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"]';

  return `(function(){
var API="${baseUrl}/api/forms";
var TORT_ID="${tortId}";
var TORT_LABEL="${config.label}";
var EXTRA_FIELDS=${JSON.stringify(config.fields)};

function el(tag,attrs,children){
  var e=document.createElement(tag);
  if(attrs)Object.keys(attrs).forEach(function(k){
    if(k==="style")Object.assign(e.style,attrs[k]);
    else if(k.startsWith("on"))e.addEventListener(k.slice(2),attrs[k]);
    else e.setAttribute(k,attrs[k]);
  });
  if(children){
    if(typeof children==="string")e.textContent=children;
    else if(Array.isArray(children))children.forEach(function(c){if(c)e.appendChild(c);});
  }
  return e;
}

function input(name,label,type,opts){
  opts=opts||{};
  var wrap=el("div",{style:{marginBottom:"12px"}});
  var lbl=el("label",{style:{display:"block",fontWeight:"600",marginBottom:"4px",fontSize:"14px"}},label+(opts.optional?"":" *"));
  var inp;
  if(type==="select"){
    inp=el("select",{name:name,style:{width:"100%",padding:"8px 12px",border:"1px solid #d1d5db",borderRadius:"6px",fontSize:"14px"}});
    inp.appendChild(el("option",{value:""},"Select..."));
    (opts.options||[]).forEach(function(o){
      var opt=el("option",{value:typeof o==="object"?o.value:o},typeof o==="object"?o.label:o);
      inp.appendChild(opt);
    });
  } else if(type==="textarea"){
    inp=el("textarea",{name:name,rows:"3",placeholder:opts.placeholder||"",style:{width:"100%",padding:"8px 12px",border:"1px solid #d1d5db",borderRadius:"6px",fontSize:"14px",resize:"vertical"}});
  } else if(type==="checkbox"){
    var cw=el("div",{style:{display:"flex",alignItems:"flex-start",gap:"8px"}});
    inp=el("input",{type:"checkbox",name:name,style:{marginTop:"3px"}});
    cw.appendChild(inp);
    cw.appendChild(el("span",{style:{fontSize:"13px",lineHeight:"1.4"}},opts.checkLabel||label));
    wrap.appendChild(cw);
    return wrap;
  } else {
    inp=el("input",{type:type||"text",name:name,placeholder:opts.placeholder||"",style:{width:"100%",padding:"8px 12px",border:"1px solid #d1d5db",borderRadius:"6px",fontSize:"14px"}});
    if(opts.maxLength)inp.setAttribute("maxlength",opts.maxLength);
    if(opts.pattern)inp.setAttribute("pattern",opts.pattern);
  }
  if(!opts.optional)inp.setAttribute("required","");
  wrap.appendChild(lbl);
  wrap.appendChild(inp);
  if(name==="email"){
    var errDiv=el("div",{id:"mtos-email-error",style:{color:"#dc2626",fontSize:"12px",marginTop:"4px",display:"none"}});
    wrap.appendChild(errDiv);
    inp.addEventListener("blur",function(){
      fetch(API+"/validate/email",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:inp.value})})
        .then(function(r){return r.json()})
        .then(function(r){
          if(!r.valid){
            errDiv.style.display="block";
            errDiv.textContent="Invalid email detected."+(r.suggestion?" Did you mean "+r.suggestion+"?":"")+" Please correct before continuing.";
            inp.style.borderColor="#dc2626";
          }else{
            errDiv.style.display="none";
            inp.style.borderColor="#d1d5db";
          }
        });
    });
  }
  return wrap;
}

function section(title,children,opts){
  opts=opts||{};
  var s=el("div",{style:{border:"1px solid #e5e7eb",borderRadius:"8px",padding:"20px",marginBottom:"16px",borderLeft:opts.accent?"4px solid "+opts.accent:""}});
  s.appendChild(el("h3",{style:{fontSize:"16px",fontWeight:"700",marginBottom:opts.note?"4px":"16px"}},title));
  if(opts.note)s.appendChild(el("p",{style:{fontSize:"12px",color:"#dc2626",marginBottom:"12px"}},opts.note));
  var grid=el("div",{style:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 16px"}});
  children.forEach(function(c){grid.appendChild(c);});
  s.appendChild(grid);
  return s;
}

var container=document.getElementById("mtos-form");
if(!container){console.error("MTOS: #mtos-form not found");return;}

var states=${allStates};
var stateOpts=states.map(function(s){return{value:s,label:s};});

var form=el("form",{id:"mtos-intake-form",style:{maxWidth:"700px",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif"}});

form.appendChild(el("h2",{style:{fontSize:"22px",fontWeight:"700",marginBottom:"4px"}},"Claim Intake: "+TORT_LABEL));
form.appendChild(el("p",{style:{fontSize:"14px",color:"#6b7280",marginBottom:"20px"}},"Complete all required fields to submit your claim for review."));

form.appendChild(section("Personal Information",[
  input("first_name","First Name"),
  input("last_name","Last Name"),
  input("date_of_birth","Date of Birth","date"),
  input("phone_primary","Phone","tel",{placeholder:"555-555-0100"}),
  input("email","Email","email",{placeholder:"you@example.com"}),
  input("last_4_ssn","Last 4 of SSN","text",{maxLength:"4",pattern:"\\\\d{4}",placeholder:"0000"}),
  input("street_address","Street Address"),
  input("city","City"),
  input("state","State","select",{options:stateOpts}),
  input("zip","Zip","text",{maxLength:"10"}),
]));

form.appendChild(section("Medical Information",[
  input("diagnosis","Diagnosis","text",{placeholder:"e.g. Non-Hodgkin Lymphoma"}),
  input("diagnosis_date","Diagnosis Date","date"),
  input("diagnosis_confirmed","Diagnosis Confirmed","checkbox",{checkLabel:"Medical diagnosis confirmed by a physician"}),
  input("was_at_location","Location Exposure","checkbox",{checkLabel:"Client was at the qualifying location for the required duration"}),
]));

if(EXTRA_FIELDS.indexOf("location_name")>=0){
  form.appendChild(input("location_name","Location Name","text",{placeholder:"e.g. MCB Camp Lejeune",optional:true}));
}

form.appendChild(section("Physician Information",[
  input("physician_first_name","Physician First Name"),
  input("physician_last_name","Physician Last Name"),
  input("physician_full_address","Physician Full Address","textarea"),
  input("physician_contact_info","Physician Contact","text",{placeholder:"Phone or email"}),
]));

form.appendChild(section("Hospital Information",[
  input("hospital_name","Hospital Name"),
  input("hospital_fax","Hospital Fax","tel",{placeholder:"555-555-0100"}),
  input("hospital_contact_info","Hospital Contact","text",{placeholder:"Phone, email, or contact person"}),
],{accent:"#dc2626",note:"All hospital fields are mandatory. Leads without complete hospital information will be rejected."}));

var compSection=section("Compliance",[
  input("tcpa_consent","TCPA Consent","checkbox",{checkLabel:"I consent to being contacted via phone, SMS, and email regarding my legal claim. I understand that this is not a condition of service."}),
],{accent:"#2563eb"});
compSection.appendChild(el("input",{type:"hidden",name:"trustedform_cert_url",id:"xxTrustedFormCertUrl_0",value:""}));
form.appendChild(compSection);

form.appendChild(el("input",{type:"hidden",name:"tort_type",value:TORT_LABEL}));
form.appendChild(el("input",{type:"hidden",name:"source",value:"form_embed_"+TORT_ID}));

var msgDiv=el("div",{id:"mtos-msg",style:{marginBottom:"12px",padding:"12px",borderRadius:"6px",display:"none"}});
form.appendChild(msgDiv);

var btnRow=el("div",{style:{display:"flex",gap:"12px",marginTop:"8px"}});
var submitBtn=el("button",{type:"submit",style:{padding:"10px 24px",background:"#1d4ed8",color:"#fff",border:"none",borderRadius:"6px",fontSize:"14px",fontWeight:"600",cursor:"pointer"}},"Submit Claim");
btnRow.appendChild(submitBtn);
form.appendChild(btnRow);

form.addEventListener("submit",function(e){
  e.preventDefault();
  submitBtn.disabled=true;
  submitBtn.textContent="Submitting...";
  msgDiv.style.display="none";

  var fd=new FormData(form);
  var payload={};
  fd.forEach(function(v,k){payload[k]=v;});
  payload.tcpa_consent=!!form.querySelector('[name=tcpa_consent]').checked;
  payload.diagnosis_confirmed=!!form.querySelector('[name=diagnosis_confirmed]').checked;
  payload.was_at_location=!!form.querySelector('[name=was_at_location]').checked;

  var tf=document.getElementById("xxTrustedFormCertUrl_0");
  if(tf&&tf.value)payload.trustedform_cert_url=tf.value;

  fetch(API+"/submit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)})
    .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})
    .then(function(r){
      if(r.ok&&r.data.status==="ACCEPTED"){
        msgDiv.style.display="block";
        msgDiv.style.background="#dcfce7";
        msgDiv.style.color="#166534";
        msgDiv.textContent="Your claim has been submitted successfully. Reference ID: "+r.data.lead_id;
        form.reset();
      }else{
        msgDiv.style.display="block";
        msgDiv.style.background="#fef2f2";
        msgDiv.style.color="#991b1b";
        msgDiv.textContent="Submission failed: "+(r.data.errors||[]).join(", ");
      }
      submitBtn.disabled=false;
      submitBtn.textContent="Submit Claim";
    })
    .catch(function(){
      msgDiv.style.display="block";
      msgDiv.style.background="#fef2f2";
      msgDiv.style.color="#991b1b";
      msgDiv.textContent="Network error. Please try again.";
      submitBtn.disabled=false;
      submitBtn.textContent="Submit Claim";
    });
});

container.appendChild(form);

var tfScript=document.createElement("script");
tfScript.type="text/javascript";
tfScript.src="https://api.trustedform.com/trustedform.js?field=xxTrustedFormCertUrl&ping_field=xxTrustedFormPingUrl&l="+(new Date().getTime())+Math.random();
document.head.appendChild(tfScript);
})();`;
}

export default router;
