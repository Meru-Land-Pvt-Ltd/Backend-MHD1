// routes/employee.js
const express = require('express');
const router  = express.Router();
const employeeController    = require('../controllers/employeeController');

// registration & login
router.post('/register', employeeController.register);
router.post('/login',    employeeController.login);

// link browsing (no entries here)
router.get('/links',      employeeController.listLinks);
router.get('/links/:linkId', employeeController.getLink);

// balance check
router.get('/balance',    employeeController.getBalance);
// full statement: every credit and payout for this employee
router.get('/balance-history',  employeeController.getMyBalanceHistory);
router.post('/balance-history', employeeController.getMyBalanceHistory);

router.get('/emailtasks', employeeController.listEmailTasks);
router.post('/taskbyuser', employeeController.taskByUser);
router.post('/pay', employeeController.deductEmployeeBalanceForTask);

router.get('/likelinks', employeeController.getLikeLinks);

module.exports = router;
