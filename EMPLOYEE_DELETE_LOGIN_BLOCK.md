# Employee deletion and login blocking

## What changed

- New admin endpoints: `POST /admin/employees/delete` with `{ "employeeId": "..." }` or `DELETE /admin/employees/:employeeId`.
- The Employee row is permanently deleted.
- Users under that employee are intentionally kept so historical tasks/reports remain intact.
- User login now requires the linked employee (`User.worksUnder`) to still exist and have `isApproved: 1`.
- Therefore, as soon as an employee is deleted, that employee cannot log in and all users under the deleted employee receive HTTP 403 with `code: EMPLOYEE_INACTIVE`.

## Example delete request

```json
{
  "employeeId": "EMPLOYEE_ID_HERE"
}
```

## Example response

```json
{
  "message": "Employee deleted successfully. Employee login and all users under this employee are now disabled.",
  "employeeId": "...",
  "employeeName": "...",
  "affectedUsers": 42,
  "historicalDataPreserved": true
}
```
