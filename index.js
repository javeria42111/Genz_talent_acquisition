// index.js (backend)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db'); // Your database connection pool

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// --- Helper: GEN_Z_SURVEY_QUESTION_IDS (for historical data logging) ---
const GEN_Z_SURVEY_QUESTION_IDS = [
  'QP_MC_1', 'QP_MC_2', 'QP_MC_3', 'QP_MC_4', 'QP_MC_5', 'QP_R_1', 'QP_R_2', 'QP_R_3', 'QP_R_4', 'QP_R_5', 'QP_R_6',
  'QP_CS_1', 'QP_CS_2', 'QP_CS_3', 'QP_CS_4', 'QP_TW_1', 'QP_TW_2', 'QP_TW_3', 'QP_TW_4', 'QP_TW_5', 'QP_TW_6',
  'QP_P_1', 'QP_P_2', 'QP_P_3', 'QP_P_4', 'QP_P_5', 'QP_P_6', 'QP_P_7', 'QP_IS_1', 'QP_IS_2', 'QP_IS_3', 'QP_IS_4', 'QP_IS_5',
  'QP_AD_1', 'QP_AD_2', 'QP_AD_3', 'QP_AD_4', 'QP_AD_5', 'QO_C_1', 'QO_C_2', 'QO_C_3', 'QO_C_4', 'QO_C_5',
  'QO_WC_1', 'QO_WC_2', 'QO_WC_3', 'QO_WC_4', 'QO_WC_5', 'QO_WC_6', 'QO_SC_1', 'QO_SC_2', 'QO_SC_3', 'QO_SC_4', 'QO_SC_5',
  'QO_ER_1', 'QO_ER_2', 'QO_ER_3', 'QO_OV_1', 'QO_OV_2', 'QO_OV_3', 'QO_OV_4', 'QO_DG_1', 'QO_DG_2'
];

// --- Helper: Add Candidate Survey to Historical Records ---
async function addCandidateSurveyToHistorical(client, survey, surveyInstanceId) {
  const historicalRecord = {
    record_id: `hist_cs_${surveyInstanceId}`, // cs for CandidateSurvey
    submission_source: survey.targetedCompanyId ? `CandidateSurvey_Targeted_${survey.targetedCompanyId}` : "CandidateSurvey_Platform",
    submission_date: survey.submittedAt || new Date().toISOString(),
    full_name: survey.personalInfo?.fullName || 'N/A',
    age: survey.personalInfo?.age || null,
    gender: survey.personalInfo?.gender || null,
    study_field: survey.personalInfo?.studyField || null,
  };

  GEN_Z_SURVEY_QUESTION_IDS.forEach(qId => {
    historicalRecord[qId] = null;
  });

  survey.responses.forEach(response => {
    if (GEN_Z_SURVEY_QUESTION_IDS.includes(response.questionId)) {
      historicalRecord[response.questionId] = response.answer;
    }
  });

  const columns = Object.keys(historicalRecord);
  const values = Object.values(historicalRecord);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

  const query = `
    INSERT INTO HistoricalSurveyRecords (${columns.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT (record_id) DO UPDATE SET
      ${columns.filter(c => c !== 'record_id').map(c => `${c} = EXCLUDED.${c}`).join(', ')};
  `;
  await client.query(query, values);
}

// --- Helper: Add Applicant Survey to Historical Records ---
async function addApplicantSurveyToHistorical(client, survey, applicantSurveyId) {
    const historicalRecord = {
        record_id: `hist_as_${applicantSurveyId}`, // as for ApplicantSurvey
        submission_source: `ApplicantSurvey_Company_${survey.companyId}_Stage_${survey.stageNumber}`,
        submission_date: survey.submittedAt || new Date().toISOString(),
        full_name: survey.applicantName,
        age: null, 
        gender: null,
        study_field: null,
    };

    GEN_Z_SURVEY_QUESTION_IDS.forEach(qId => {
        historicalRecord[qId] = null;
    });

    survey.responses.forEach(response => {
        if (GEN_Z_SURVEY_QUESTION_IDS.includes(response.questionId)) {
        historicalRecord[response.questionId] = response.answer;
        }
    });
    
    const columns = Object.keys(historicalRecord);
    const values = Object.values(historicalRecord);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

    const query = `
        INSERT INTO HistoricalSurveyRecords (${columns.join(', ')})
        VALUES (${placeholders})
        ON CONFLICT (record_id) DO UPDATE SET
        ${columns.filter(c => c !== 'record_id').map(c => `${c} = EXCLUDED.${c}`).join(', ')};
    `;
    await client.query(query, values);
}

// Test Route
app.get('/', (req, res) => {
  res.send('TalentInsight Hub Backend is running with new SQL schema!');
});

// === USER AUTHENTICATION & MANAGEMENT ===
app.post('/api/auth/signup', async (req, res) => {
  const { fullName, email, role } = req.body; 
  // Password validation is done on frontend; backend only stores user info per schema

  if (!fullName || !email || !role) {
    return res.status(400).json({ error: 'Full Name, Email, and Role are required.' });
  }
  if (!['CANDIDATE', 'COMPANY', 'ADMIN'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role specified.' });
  }
  if (!/\S+@\S+\.\S+/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = `user_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const newUserQuery = `
      INSERT INTO Users (id, full_name, email, role)
      VALUES ($1, $2, $3, $4)
      RETURNING id, full_name, email, role;
    `;
    const values = [userId, fullName, email, role];
    const result = await client.query(newUserQuery, values);
    const newUser = result.rows[0];

    // If a new COMPANY user is created, initialize their CompanySettings
    if (newUser.role === 'COMPANY') {
      await client.query(
        `INSERT INTO CompanySettings (company_id, company_name, total_interviews)
         VALUES ($1, $2, $3) ON CONFLICT (company_id) DO NOTHING;`,
        [newUser.id, newUser.full_name, 1] // Default total_interviews to 1
      );
    }
    await client.query('COMMIT');
    res.status(201).json({
      message: 'User registered successfully!',
      user: newUser
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error registering user:', error);
    if (error.code === '23505') { 
        return res.status(409).json({ error: 'This email is already registered.' });
    }
    res.status(500).json({ error: 'Internal server error while registering user.' });
  } finally {
    client.release();
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body; 
  if (!email) { 
    return res.status(400).json({ error: 'Email is required.' });
  }
  // Actual password check against a hashed password would go here if schema supported it.
  // For now, just finds user by email.
  try {
    const userQuery = 'SELECT id, full_name, email, role FROM Users WHERE email = $1';
    const result = await pool.query(userQuery, [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or user not found.' });
    }
    const user = result.rows[0];
    res.status(200).json({
      message: 'Login successful!',
      user: user
    });
  } catch (error) {
    console.error('Error logging in user:', error);
    res.status(500).json({ error: 'Internal server error during login.' });
  }
});

app.get('/api/admin/users', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, full_name, email, role FROM Users ORDER BY full_name');
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching all users:', error);
        res.status(500).json({ error: 'Internal server error while fetching users.' });
    }
});

// === CANDIDATE SURVEYS ===
// POST /api/surveys - Submit a new candidate survey (General or Targeted)
app.post('/api/surveys', async (req, res) => {
  const { userId, personalInfo, responses, targetedCompanyId } = req.body;

  if (!userId || !personalInfo || !responses || !Array.isArray(responses) || responses.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid survey data.' });
  }
  if (!personalInfo.fullName || !personalInfo.email) {
    return res.status(400).json({ error: 'Full Name and Email are required in personalInfo.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const surveyInstanceId = `survey_${Date.now()}_${userId.slice(-4)}`;
    const submittedAt = new Date();

    const candidateSurveyQuery = `
      INSERT INTO CandidateSurveys (survey_instance_id, user_id, submitted_at, targeted_company_id)
      VALUES ($1, $2, $3, $4) RETURNING survey_instance_id;
    `;
    await client.query(candidateSurveyQuery, [surveyInstanceId, userId, submittedAt, targetedCompanyId || null]);

    const piQuery = `
      INSERT INTO SurveyPersonalInformation
        (survey_instance_id, full_name, email, phone_number, city, linked_in_url, age, study_field, gender, other_city)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
    `;
    await client.query(piQuery, [
      surveyInstanceId, personalInfo.fullName, personalInfo.email, personalInfo.phoneNumber || null,
      personalInfo.city || null, personalInfo.linkedInUrl || null, personalInfo.age || null,
      personalInfo.studyField || null, personalInfo.gender || null, personalInfo.otherCity || null
    ]);

    for (const response of responses) {
      if (!response.questionId || typeof response.answer !== 'number') {
        throw new Error('Invalid response item format.');
      }
      const responseQuery = `
        INSERT INTO SurveyResponses (survey_instance_id, question_id, answer)
        VALUES ($1, $2, $3);
      `;
      await client.query(responseQuery, [surveyInstanceId, response.questionId, response.answer]);
    }
    
    const fullSurveyDataForHistorical = { userId, personalInfo, responses, submittedAt, targetedCompanyId };
    await addCandidateSurveyToHistorical(client, fullSurveyDataForHistorical, surveyInstanceId);

    await client.query('COMMIT');
    const submittedSurveyData = { surveyInstanceId, userId, personalInfo, responses, submittedAt: submittedAt.toISOString(), targetedCompanyId: targetedCompanyId || null };
    res.status(201).json({ message: 'Survey submitted successfully!', survey: submittedSurveyData });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error submitting survey:', error);
    res.status(500).json({ error: 'Internal server error while submitting survey.' });
  } finally {
    client.release();
  }
});

// PUT /api/surveys/:surveyInstanceId - Update an existing candidate survey (typically general survey)
app.put('/api/surveys/:surveyInstanceId', async (req, res) => {
  const { surveyInstanceId } = req.params;
  const { userId, personalInfo, responses } = req.body;

  if (!userId || !personalInfo || !responses || !Array.isArray(responses)) {
    return res.status(400).json({ error: 'Missing or invalid survey data for update.' });
  }
  if (!personalInfo.fullName || !personalInfo.email) {
      return res.status(400).json({ error: 'Full Name and Email are required in personalInfo for update.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const surveyCheck = await client.query('SELECT user_id, targeted_company_id FROM CandidateSurveys WHERE survey_instance_id = $1', [surveyInstanceId]);
    if (surveyCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Survey not found.' });
    }
    if (surveyCheck.rows[0].targeted_company_id !== null) { 
       await client.query('ROLLBACK');
       return res.status(400).json({ error: 'Only general surveys can be updated this way.' });
    }

    const piUpdateQuery = `
      UPDATE SurveyPersonalInformation
      SET full_name = $1, email = $2, phone_number = $3, city = $4, 
          linked_in_url = $5, age = $6, study_field = $7, gender = $8, other_city = $9
      WHERE survey_instance_id = $10;
    `;
    await client.query(piUpdateQuery, [
      personalInfo.fullName, personalInfo.email, personalInfo.phoneNumber || null,
      personalInfo.city || null, personalInfo.linkedInUrl || null, personalInfo.age || null,
      personalInfo.studyField || null, personalInfo.gender || null, personalInfo.otherCity || null,
      surveyInstanceId
    ]);

    await client.query('DELETE FROM SurveyResponses WHERE survey_instance_id = $1', [surveyInstanceId]);
    for (const response of responses) {
      if (!response.questionId || typeof response.answer !== 'number') {
        throw new Error('Invalid response item format during update.');
      }
      const responseQuery = `
        INSERT INTO SurveyResponses (survey_instance_id, question_id, answer)
        VALUES ($1, $2, $3);
      `;
      await client.query(responseQuery, [surveyInstanceId, response.questionId, response.answer]);
    }
    
    const submittedAt = new Date();
    await client.query('UPDATE CandidateSurveys SET submitted_at = $1 WHERE survey_instance_id = $2', [submittedAt, surveyInstanceId]);
    
    const fullSurveyDataForHistorical = { userId, personalInfo, responses, submittedAt, targetedCompanyId: null };
    await addCandidateSurveyToHistorical(client, fullSurveyDataForHistorical, surveyInstanceId);

    await client.query('COMMIT');
    const updatedSurveyData = { surveyInstanceId, userId, personalInfo, responses, submittedAt: submittedAt.toISOString(), targetedCompanyId: null };
    res.status(200).json({ message: 'Survey updated successfully!', survey: updatedSurveyData });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating survey:', error);
    res.status(500).json({ error: 'Internal server error while updating survey.' });
  } finally {
    client.release();
  }
});

// Common function to build survey data from rows
function buildSurveysFromRows(rows) {
    if (rows.length === 0) return [];
    const surveysMap = new Map();
    rows.forEach(row => {
        if (!surveysMap.has(row.survey_instance_id)) {
            surveysMap.set(row.survey_instance_id, {
                surveyInstanceId: row.survey_instance_id,
                userId: row.user_id,
                submittedAt: row.submitted_at.toISOString(),
                targetedCompanyId: row.targeted_company_id,
                personalInfo: {
                    fullName: row.pi_full_name, email: row.pi_email, phoneNumber: row.pi_phone_number,
                    city: row.pi_city, linkedInUrl: row.pi_linked_in_url, age: row.pi_age,
                    studyField: row.pi_study_field, gender: row.pi_gender, otherCity: row.pi_other_city
                },
                responses: []
            });
        }
        if (row.question_id && row.answer !== null) {
            surveysMap.get(row.survey_instance_id).responses.push({
                questionId: row.question_id,
                answer: row.answer
            });
        }
    });
    return Array.from(surveysMap.values());
}

app.get('/api/surveys/user/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const query = `
            SELECT cs.*, 
                   spi.full_name as pi_full_name, spi.email as pi_email, spi.phone_number as pi_phone_number,
                   spi.city as pi_city, spi.linked_in_url as pi_linked_in_url, spi.age as pi_age,
                   spi.study_field as pi_study_field, spi.gender as pi_gender, spi.other_city as pi_other_city,
                   sr.question_id, sr.answer
            FROM CandidateSurveys cs
            LEFT JOIN SurveyPersonalInformation spi ON cs.survey_instance_id = spi.survey_instance_id
            LEFT JOIN SurveyResponses sr ON cs.survey_instance_id = sr.survey_instance_id
            WHERE cs.user_id = $1
            ORDER BY cs.submitted_at DESC, cs.survey_instance_id, sr.question_id ASC;
        `;
        const { rows } = await pool.query(query, [userId]);
        res.status(200).json(buildSurveysFromRows(rows));
    } catch (error) {
        console.error(`Error fetching surveys for user ${userId}:`, error);
        res.status(500).json({ error: 'Internal server error while fetching user surveys.' });
    }
});

app.get('/api/surveys/user/:userId/general', async (req, res) => {
    const { userId } = req.params;
    try {
        const query = `
            SELECT cs.*,
                   spi.full_name as pi_full_name, spi.email as pi_email, spi.phone_number as pi_phone_number,
                   spi.city as pi_city, spi.linked_in_url as pi_linked_in_url, spi.age as pi_age,
                   spi.study_field as pi_study_field, spi.gender as pi_gender, spi.other_city as pi_other_city,
                   sr.question_id, sr.answer
            FROM CandidateSurveys cs
            LEFT JOIN SurveyPersonalInformation spi ON cs.survey_instance_id = spi.survey_instance_id
            LEFT JOIN SurveyResponses sr ON cs.survey_instance_id = sr.survey_instance_id
            WHERE cs.user_id = $1 AND cs.targeted_company_id IS NULL
            ORDER BY cs.submitted_at DESC, cs.survey_instance_id, sr.question_id ASC
            LIMIT 1;
        `;
        const { rows } = await pool.query(query, [userId]);
        const surveys = buildSurveysFromRows(rows);
        if (surveys.length > 0) {
            res.status(200).json(surveys[0]);
        } else {
            res.status(200).json(null); // Send null if not found, as per frontend expectation
        }
    } catch (error) {
        console.error(`Error fetching general survey for user ${userId}:`, error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

app.get('/api/surveys/user/:userId/targeted/:companyId', async (req, res) => {
    const { userId, companyId } = req.params;
    try {
        const query = `
            SELECT cs.*,
                   spi.full_name as pi_full_name, spi.email as pi_email, spi.phone_number as pi_phone_number,
                   spi.city as pi_city, spi.linked_in_url as pi_linked_in_url, spi.age as pi_age,
                   spi.study_field as pi_study_field, spi.gender as pi_gender, spi.other_city as pi_other_city,
                   sr.question_id, sr.answer
            FROM CandidateSurveys cs
            LEFT JOIN SurveyPersonalInformation spi ON cs.survey_instance_id = spi.survey_instance_id
            LEFT JOIN SurveyResponses sr ON cs.survey_instance_id = sr.survey_instance_id
            WHERE cs.user_id = $1 AND cs.targeted_company_id = $2
            ORDER BY cs.submitted_at DESC, cs.survey_instance_id, sr.question_id ASC
            LIMIT 1;
        `;
        const { rows } = await pool.query(query, [userId, companyId]);
        const surveys = buildSurveysFromRows(rows);
        if (surveys.length > 0) {
            res.status(200).json(surveys[0]);
        } else {
            res.status(200).json(null); // Send null if not found
        }
    } catch (error) {
        console.error(`Error fetching targeted survey for user ${userId}, company ${companyId}:`, error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

app.get('/api/admin/surveys', async (req, res) => {
    try {
        const query = `
            SELECT cs.*,
                   spi.full_name as pi_full_name, spi.email as pi_email, spi.phone_number as pi_phone_number,
                   spi.city as pi_city, spi.linked_in_url as pi_linked_in_url, spi.age as pi_age,
                   spi.study_field as pi_study_field, spi.gender as pi_gender, spi.other_city as pi_other_city,
                   sr.question_id, sr.answer
            FROM CandidateSurveys cs
            LEFT JOIN SurveyPersonalInformation spi ON cs.survey_instance_id = spi.survey_instance_id
            LEFT JOIN SurveyResponses sr ON cs.survey_instance_id = sr.survey_instance_id
            ORDER BY cs.submitted_at DESC, cs.survey_instance_id, sr.question_id ASC;
        `;
        const { rows } = await pool.query(query);
        res.status(200).json(buildSurveysFromRows(rows));
    } catch (error) {
        console.error('Error fetching all surveys for admin:', error);
        res.status(500).json({ error: 'Internal server error while fetching all surveys.' });
    }
});


// === COMPANY APPLICANT SURVEYS ===
app.post('/api/company-applicant-surveys', async (req, res) => {
    const { companyId, applicantEmail, applicantName, stageNumber, responses } = req.body;

    if (!companyId || !applicantEmail || !applicantName || stageNumber === undefined || !responses || !Array.isArray(responses)) {
        return res.status(400).json({ error: 'Missing or invalid applicant survey data.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const uniqueSurveyId = `appsurvey_${Date.now()}_${companyId.slice(-4)}`;
        const submittedAt = new Date();

        const applicantSurveyQuery = `
            INSERT INTO CompanyApplicantSurveys (unique_survey_id, company_id, applicant_email, applicant_name, stage_number, submitted_at)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING unique_survey_id;
        `;
        await client.query(applicantSurveyQuery, [uniqueSurveyId, companyId, applicantEmail, applicantName, stageNumber, submittedAt]);

        for (const response of responses) {
            if (!response.questionId || typeof response.answer !== 'number') {
                throw new Error('Invalid response item format for applicant survey.');
            }
            const responseQuery = `
                INSERT INTO ApplicantSurveyResponses (applicant_survey_id, question_id, answer)
                VALUES ($1, $2, $3);
            `;
            await client.query(responseQuery, [uniqueSurveyId, response.questionId, response.answer]);
        }
        
        const fullSurveyDataForHistorical = { companyId, applicantEmail, applicantName, stageNumber, responses, submittedAt };
        await addApplicantSurveyToHistorical(client, fullSurveyDataForHistorical, uniqueSurveyId);

        await client.query('COMMIT');
        const submittedSurvey = { uniqueSurveyId, companyId, applicantEmail, applicantName, stageNumber, responses, submittedAt: submittedAt.toISOString() };
        res.status(201).json({ message: 'Applicant survey submitted successfully!', survey: submittedSurvey });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error submitting company applicant survey:', error);
        res.status(500).json({ error: 'Internal server error while submitting applicant survey.' });
    } finally {
        client.release();
    }
});

app.get('/api/companies/:companyId/applicant-surveys', async (req, res) => {
    const { companyId } = req.params;
    try {
        const query = `
            SELECT cas.*, asr.question_id, asr.answer
            FROM CompanyApplicantSurveys cas
            LEFT JOIN ApplicantSurveyResponses asr ON cas.unique_survey_id = asr.applicant_survey_id
            WHERE cas.company_id = $1
            ORDER BY cas.submitted_at DESC, cas.unique_survey_id, asr.question_id ASC;
        `;
        const { rows } = await pool.query(query, [companyId]);
        if (rows.length === 0) return res.status(200).json([]);

        const surveysMap = new Map();
        rows.forEach(row => {
            if (!surveysMap.has(row.unique_survey_id)) {
                surveysMap.set(row.unique_survey_id, {
                    uniqueSurveyId: row.unique_survey_id,
                    companyId: row.company_id,
                    applicantEmail: row.applicant_email,
                    applicantName: row.applicant_name,
                    stageNumber: row.stage_number,
                    submittedAt: row.submitted_at.toISOString(),
                    responses: []
                });
            }
            if (row.question_id && row.answer !== null) {
                surveysMap.get(row.unique_survey_id).responses.push({
                    questionId: row.question_id,
                    answer: row.answer
                });
            }
        });
        res.status(200).json(Array.from(surveysMap.values()));
    } catch (error) {
        console.error(`Error fetching applicant surveys for company ${companyId}:`, error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// --- COMPANY SETTINGS Endpoints (Updated Path & Logic) ---
async function fetchCompanySettingsData(client, companyId) {
    const settingsRes = await client.query('SELECT * FROM CompanySettings WHERE company_id = $1', [companyId]);
    if (settingsRes.rows.length === 0) return null;
    const csData = settingsRes.rows[0];

    const personalAttrRes = await client.query('SELECT category_id, rank FROM CompanyAttributePreferences WHERE company_id = $1 AND attribute_type = $2', [companyId, 'personal']);
    csData.personalAttributePreferences = personalAttrRes.rows.map(r => ({ categoryId: r.category_id, rank: r.rank }));

    const orgAttrRes = await client.query('SELECT category_id, rank FROM CompanyAttributePreferences WHERE company_id = $1 AND attribute_type = $2', [companyId, 'organizational']);
    csData.organizationalAttributePreferences = orgAttrRes.rows.map(r => ({ categoryId: r.category_id, rank: r.rank }));

    const globalQRes = await client.query('SELECT original_question_id, custom_text FROM CompanyGlobalCustomQuestions WHERE company_id = $1', [companyId]);
    csData.globalCustomQuestions = globalQRes.rows.map(r => ({ originalQuestionId: r.original_question_id, customText: r.custom_text }));

    const stagesRes = await client.query('SELECT stage_setting_id, stage_number FROM CompanyInterviewStageSettings WHERE company_id = $1 ORDER BY stage_number ASC', [companyId]);
    csData.interviewStageSettings = [];
    for (const stageRow of stagesRes.rows) {
        const binaryAssessmentsRes = await client.query('SELECT category_id, assessed FROM StageBinaryAssessments WHERE stage_setting_id = $1', [stageRow.stage_setting_id]);
        const stageCustomQuestionsRes = await client.query('SELECT original_question_id, custom_text FROM StageCustomQuestions WHERE stage_setting_id = $1', [stageRow.stage_setting_id]);
        csData.interviewStageSettings.push({
            stageSettingId: stageRow.stage_setting_id, // Keep if needed, not in frontend type
            stageNumber: stageRow.stage_number,
            binaryAssessments: binaryAssessmentsRes.rows.map(r => ({ categoryId: r.category_id, assessed: r.assessed })),
            customQuestions: stageCustomQuestionsRes.rows.map(r => ({ originalQuestionId: r.original_question_id, customText: r.custom_text })),
        });
    }
     return { // Match frontend CompanySettings type
        companyId: csData.company_id,
        companyName: csData.company_name,
        companySize: csData.company_size,
        companyType: csData.company_type,
        companyLinkedIn: csData.company_linkedin,
        companyWebsite: csData.company_website,
        address: csData.address,
        contactPersonName: csData.contact_person_name,
        contactPersonEmail: csData.contact_person_email,
        contactPersonDesignation: csData.contact_person_designation,
        companyPhoneNumber: csData.company_phone_number,
        totalInterviews: csData.total_interviews,
        personalAttributePreferences: csData.personalAttributePreferences,
        organizationalAttributePreferences: csData.organizationalAttributePreferences,
        globalCustomQuestions: csData.globalCustomQuestions,
        interviewStageSettings: csData.interviewStageSettings,
    };
}

app.get('/api/companies/:companyId/settings', async (req, res) => {
    const { companyId } = req.params;
    const client = await pool.connect();
    try {
        const settingsData = await fetchCompanySettingsData(client, companyId);
        if (!settingsData) {
            // Check if the user exists and is a company
            const userCheck = await client.query('SELECT role FROM Users WHERE id = $1', [companyId]);
            if (userCheck.rows.length > 0 && userCheck.rows[0].role === 'COMPANY') {
                // If user exists but no settings, create default settings and return them
                await client.query(
                    'INSERT INTO CompanySettings (company_id, company_name, total_interviews) VALUES ($1, $2, $3) ON CONFLICT (company_id) DO NOTHING',
                    [companyId, `Company ${companyId}`, 1]
                );
                const newSettingsData = await fetchCompanySettingsData(client, companyId);
                return res.status(200).json(newSettingsData || {}); // Should not be null now
            }
            return res.status(404).json({ error: 'Company settings not found and user is not a valid company.' });
        }
        res.status(200).json(settingsData);
    } catch (error) {
        console.error(`Error fetching settings for company ${companyId}:`, error);
        res.status(500).json({ error: 'Internal server error.' });
    } finally {
        client.release();
    }
});

app.put('/api/companies/:companyId/settings', async (req, res) => {
    const { companyId } = req.params;
    const settingsData = req.body; 
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const checkExist = await client.query('SELECT company_id FROM CompanySettings WHERE company_id = $1', [companyId]);
        if (checkExist.rows.length === 0) {
            const userCheck = await client.query('SELECT role, full_name FROM Users WHERE id = $1', [companyId]);
            if (userCheck.rows.length === 0 || userCheck.rows[0].role !== 'COMPANY') {
                 await client.query('ROLLBACK');
                 return res.status(400).json({ error: 'Invalid company ID or user is not a company.' });
            }
            await client.query(
                'INSERT INTO CompanySettings (company_id, company_name, total_interviews) VALUES ($1, $2, $3)',
                [companyId, settingsData.companyName || userCheck.rows[0].full_name || `Company ${companyId}`, settingsData.totalInterviews || 1]
            );
        }

        await client.query(
            `UPDATE CompanySettings SET 
                company_name = $1, company_size = $2, company_type = $3, company_linkedin = $4, 
                company_website = $5, address = $6, contact_person_name = $7, contact_person_email = $8, 
                contact_person_designation = $9, company_phone_number = $10, total_interviews = $11
             WHERE company_id = $12`,
            [
                settingsData.companyName, settingsData.companySize, settingsData.companyType, settingsData.companyLinkedIn,
                settingsData.companyWebsite, settingsData.address, settingsData.contactPersonName, settingsData.contactPersonEmail,
                settingsData.contactPersonDesignation, settingsData.companyPhoneNumber, settingsData.totalInterviews,
                companyId
            ]
        );
        await client.query('DELETE FROM CompanyAttributePreferences WHERE company_id = $1', [companyId]);
        if (settingsData.personalAttributePreferences) {
            for (const pref of settingsData.personalAttributePreferences) {
                await client.query('INSERT INTO CompanyAttributePreferences (company_id, category_id, rank, attribute_type) VALUES ($1, $2, $3, $4)', [companyId, pref.categoryId, pref.rank, 'personal']);
            }
        }
        if (settingsData.organizationalAttributePreferences) {
            for (const pref of settingsData.organizationalAttributePreferences) {
                await client.query('INSERT INTO CompanyAttributePreferences (company_id, category_id, rank, attribute_type) VALUES ($1, $2, $3, $4)', [companyId, pref.categoryId, pref.rank, 'organizational']);
            }
        }
        await client.query('DELETE FROM CompanyGlobalCustomQuestions WHERE company_id = $1', [companyId]);
        if (settingsData.globalCustomQuestions) {
            for (const q of settingsData.globalCustomQuestions) {
                await client.query('INSERT INTO CompanyGlobalCustomQuestions (company_id, original_question_id, custom_text) VALUES ($1, $2, $3)', [companyId, q.originalQuestionId, q.customText]);
            }
        }
        const oldStagesRes = await client.query('SELECT stage_setting_id FROM CompanyInterviewStageSettings WHERE company_id = $1', [companyId]);
        for (const oldStage of oldStagesRes.rows) {
            await client.query('DELETE FROM StageBinaryAssessments WHERE stage_setting_id = $1', [oldStage.stage_setting_id]);
            await client.query('DELETE FROM StageCustomQuestions WHERE stage_setting_id = $1', [oldStage.stage_setting_id]);
        }
        await client.query('DELETE FROM CompanyInterviewStageSettings WHERE company_id = $1', [companyId]);

        if (settingsData.interviewStageSettings) {
            for (const stage of settingsData.interviewStageSettings) {
                const stageRes = await client.query('INSERT INTO CompanyInterviewStageSettings (company_id, stage_number) VALUES ($1, $2) RETURNING stage_setting_id', [companyId, stage.stageNumber]);
                const stageSettingId = stageRes.rows[0].stage_setting_id;
                if (stage.binaryAssessments) {
                    for (const ba of stage.binaryAssessments) {
                        await client.query('INSERT INTO StageBinaryAssessments (stage_setting_id, category_id, assessed) VALUES ($1, $2, $3)', [stageSettingId, ba.categoryId, ba.assessed]);
                    }
                }
                if (stage.customQuestions) {
                    for (const cq of stage.customQuestions) {
                        await client.query('INSERT INTO StageCustomQuestions (stage_setting_id, original_question_id, custom_text) VALUES ($1, $2, $3)', [stageSettingId, cq.originalQuestionId, cq.customText]);
                    }
                }
            }
        }
        await client.query('COMMIT');
        const updatedSettings = await fetchCompanySettingsData(client, companyId); 
        res.status(200).json(updatedSettings); // Frontend companyService expects the updated settings object directly
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Error updating settings for company ${companyId}:`, error);
        res.status(500).json({ error: 'Internal server error while updating company settings.' });
    } finally {
        client.release();
    }
});

app.get('/api/admin/company-settings', async (req, res) => {
    const client = await pool.connect();
    try {
        const companyUsers = await client.query("SELECT id FROM Users WHERE role = 'COMPANY'");
        if (companyUsers.rows.length === 0) {
            return res.status(200).json([]);
        }
        const allSettings = [];
        for (const user of companyUsers.rows) {
            const settings = await fetchCompanySettingsData(client, user.id);
            if (settings) {
                allSettings.push(settings);
            }
        }
        res.status(200).json(allSettings);
    } catch (error) {
        console.error('Error fetching all company settings for admin:', error);
        res.status(500).json({ error: 'Internal server error.' });
    } finally {
        client.release();
    }
});

// === HISTORICAL DATA (Admin) ===
app.post('/api/admin/historical-records/upload', async (req, res) => {
    const records = req.body; // Expects an array of HistoricalSurveyRecord objects
    if (!Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ error: 'No records provided for upload.' });
    }

    const client = await pool.connect();
    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    try {
        await client.query('BEGIN');
        for (const record of records) {
            try {
                const columns = Object.keys(record).filter(key => key !== 'recordId' || record.recordId); // Handle if recordId is temporary
                const values = columns.map(col => record[col]);
                
                let finalRecordId = record.recordId;
                if (!finalRecordId) finalRecordId = `hist_auto_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

                const historicalRecord = {
                  record_id: finalRecordId,
                  submission_source: record.submissionSource || "CSV_Upload",
                  submission_date: record.submissionDate || new Date().toISOString(),
                  full_name: record.FullName, // Note: CSV has FullName, table has full_name
                  age: record.Age,
                  gender: record.Gender,
                  study_field: record.Study_field,
                };
                GEN_Z_SURVEY_QUESTION_IDS.forEach(qId => {
                    historicalRecord[qId] = record[qId] !== undefined ? record[qId] : null;
                });
                
                const dbColumns = Object.keys(historicalRecord);
                const dbValues = Object.values(historicalRecord);
                const placeholders = dbColumns.map((_, i) => `$${i + 1}`).join(', ');

                const query = `
                    INSERT INTO HistoricalSurveyRecords (${dbColumns.join(', ')})
                    VALUES (${placeholders})
                    ON CONFLICT (record_id) DO UPDATE SET
                      ${dbColumns.filter(c => c !== 'record_id').map(c => `${c} = EXCLUDED.${c}`).join(', ')};
                `;
                await client.query(query, dbValues);
                successCount++;
            } catch (indError) {
                errorCount++;
                errors.push(`Error processing record for ${record.FullName || record.recordId}: ${indError.message}`);
                console.error(`Error processing historical record ${record.FullName}:`, indError);
            }
        }
        await client.query('COMMIT');
        res.status(200).json({ successCount, errorCount, errors, message: `${successCount} records processed.` });
    } catch (batchError) {
        await client.query('ROLLBACK');
        console.error('Batch historical records upload error:', batchError);
        res.status(500).json({ error: 'Batch upload failed due to a server error.', successCount, errorCount, errors: [...errors, batchError.message] });
    } finally {
        client.release();
    }
});

app.get('/api/admin/historical-records', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM HistoricalSurveyRecords ORDER BY submission_date DESC');
        // Convert column names from snake_case to camelCase for frontend if needed by types.ts HistoricalSurveyRecord
        const records = result.rows.map(row => ({
            recordId: row.record_id,
            submissionSource: row.submission_source,
            submissionDate: row.submission_date.toISOString(),
            FullName: row.full_name, // Match frontend type
            Age: row.age,
            Gender: row.gender,
            Study_field: row.study_field,
            ...GEN_Z_SURVEY_QUESTION_IDS.reduce((acc, qId) => {
                acc[qId] = row[qId.toLowerCase()]; // DB columns are lowercase from schema
                return acc;
            }, {})
        }));
        res.status(200).json(records);
    } catch (error) {
        console.error('Error fetching historical records:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// === BATCH COMPANY PREFERENCES IMPORT (Admin) ===
app.post('/api/admin/company-preferences/batch-import', async (req, res) => {
    const { rankingsInput, binaryAssessmentsInput } = req.body;
    // rankingsInput: HistoricalCompanyRankingInput[] [{ EMPLOYEER: string, [attributeName: string]: number }]
    // binaryAssessmentsInput: HistoricalCompanyBinaryAssessmentInput[] [{ EMPLOYEER: string, [attributeName: string]: boolean }]
    
    if ((!rankingsInput || rankingsInput.length === 0) && (!binaryAssessmentsInput || binaryAssessmentsInput.length === 0)) {
        return res.status(400).json({ error: 'No ranking or assessment data provided.' });
    }

    const client = await pool.connect();
    let createdCount = 0;
    let updatedCount = 0;
    const errors = [];

    try {
        await client.query('BEGIN');
        const allEmployeers = new Set([
            ...(rankingsInput || []).map(r => r.EMPLOYEER),
            ...(binaryAssessmentsInput || []).map(a => a.EMPLOYEER)
        ]);

        for (const employeerName of allEmployeers) {
            try {
                // 1. Find or Create User
                let userResult = await client.query("SELECT id FROM Users WHERE full_name = $1 AND role = 'COMPANY'", [employeerName]);
                let companyUserId;
                let isNewUser = false;
                if (userResult.rows.length === 0) {
                    const newUserId = `comp_user_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
                    // Create a dummy email, actual email should ideally come from CSV or be manually updated later
                    const dummyEmail = `${employeerName.toLowerCase().replace(/\s+/g, '.')}@example.csv.com`;
                    const newUserInsert = await client.query(
                        "INSERT INTO Users (id, full_name, email, role) VALUES ($1, $2, $3, 'COMPANY') RETURNING id",
                        [newUserId, employeerName, dummyEmail]
                    );
                    companyUserId = newUserInsert.rows[0].id;
                    isNewUser = true;
                } else {
                    companyUserId = userResult.rows[0].id;
                }

                // 2. Find or Create CompanySettings
                let settingsResult = await client.query("SELECT company_id FROM CompanySettings WHERE company_id = $1", [companyUserId]);
                if (settingsResult.rows.length === 0) {
                    await client.query(
                        "INSERT INTO CompanySettings (company_id, company_name, total_interviews) VALUES ($1, $2, $3)",
                        [companyUserId, employeerName, 1] // Default total_interviews to 1 for CSV import
                    );
                    if (isNewUser) createdCount++; else updatedCount++; // Count settings creation for existing user as update
                } else {
                    updatedCount++;
                }

                // 3. Process Rankings
                const companyRankings = (rankingsInput || []).find(r => r.EMPLOYEER === employeerName);
                if (companyRankings) {
                    await client.query("DELETE FROM CompanyAttributePreferences WHERE company_id = $1", [companyUserId]);
                    for (const attrName in companyRankings) {
                        if (attrName !== 'EMPLOYEER') {
                            const rank = companyRankings[attrName];
                            // Determine attribute_type based on attribute name prefix or category mapping
                            const attributeType = GEN_Z_SURVEY_QUESTION_IDS.some(id => id.startsWith('QP_') && GEN_Z_SURVEY_QUESTION_IDS.find(q => q.category === attrName)) ? 'personal' : 'organizational';
                            await client.query(
                                "INSERT INTO CompanyAttributePreferences (company_id, category_id, rank, attribute_type) VALUES ($1, $2, $3, $4)",
                                [companyUserId, attrName, rank, attributeType]
                            );
                        }
                    }
                }

                // 4. Process Binary Assessments (for Stage 1)
                const companyAssessments = (binaryAssessmentsInput || []).find(a => a.EMPLOYEER === employeerName);
                if (companyAssessments) {
                    // Ensure Stage 1 setting exists
                    let stageSettingRes = await client.query("SELECT stage_setting_id FROM CompanyInterviewStageSettings WHERE company_id = $1 AND stage_number = 1", [companyUserId]);
                    let stageSettingId;
                    if (stageSettingRes.rows.length === 0) {
                        const newStageRes = await client.query("INSERT INTO CompanyInterviewStageSettings (company_id, stage_number) VALUES ($1, 1) RETURNING stage_setting_id", [companyUserId]);
                        stageSettingId = newStageRes.rows[0].stage_setting_id;
                    } else {
                        stageSettingId = stageSettingRes.rows[0].stage_setting_id;
                    }
                    await client.query("DELETE FROM StageBinaryAssessments WHERE stage_setting_id = $1", [stageSettingId]);
                    for (const attrName in companyAssessments) {
                        if (attrName !== 'EMPLOYEER') {
                            const assessed = companyAssessments[attrName]; // boolean
                            await client.query(
                                "INSERT INTO StageBinaryAssessments (stage_setting_id, category_id, assessed) VALUES ($1, $2, $3)",
                                [stageSettingId, attrName, assessed]
                            );
                        }
                    }
                }
            } catch(empError) {
                errors.push(`Error processing preferences for ${employeerName}: ${empError.message}`);
                console.error(`Error for ${employeerName} in batch import:`, empError);
            }
        }

        await client.query('COMMIT');
        res.status(200).json({ created: createdCount, updated: updatedCount, errors, message: `Company preferences batch import processed.` });

    } catch (batchError) {
        await client.query('ROLLBACK');
        console.error('Batch company preferences import error:', batchError);
        res.status(500).json({ error: 'Batch import failed due to a server error.', created: createdCount, updated: updatedCount, errors: [...errors, batchError.message] });
    } finally {
        client.release();
    }
});


// Start the server
app.listen(PORT, () => {
  console.log(`✅ Backend server running on port ${PORT}`);
  pool.query('SELECT NOW()', (err, result) => {
    if (err) {
      console.error('❌ Error connecting to PostgreSQL database:', err.stack);
    } else {
      console.log('✅ Successfully connected to PostgreSQL database at', result.rows[0].now);
    }
  });
});

